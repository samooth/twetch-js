const BSVABI = require('../../bsvabi/bsvabi');
const axios = require('axios');
const InMemoryStorage = require('../storage/in-memory-storage');
const SimpleWallet = require('../wallet/simple-wallet');
const AuthApi = require('../../shared-helpers/auth-api');
const Helpers = require('../../shared-helpers/index');
const crypto = require('../crypto');

class Client {
	constructor(options = {}) {
		const Storage = options.Storage || InMemoryStorage;
		const Wallet = options.Wallet || SimpleWallet;

		this.options = options;
		this.storage = new Storage(options);
		this.wallet = new Wallet({ ...options, Storage });
		this.clientIdentifier = options.clientIdentifier || 'e4c86c79-3eec-4069-a25c-8436ba8c6009';
		this.network = options.network || 'mainnet';
		this.client = axios.create({
			baseURL: options.apiUrl || 'https://api.twetch.app/v1',
			headers: {
				Authorization: `Bearer ${this.storage.getItem('tokenTwetchAuth')}`
			}
		});
		this.initAbi();
	}

	get Helpers() {
		return Helpers;
	}

	get BSVABI() {
		return BSVABI;
	}

	get crypto() {
		return crypto;
	}

	async createMnemonic() {
		const mnemonic = this.crypto.generateMnemonic();
		return this.syncPublicKeys(mnemonic);
	}

	async syncPublicKeys(mnemonic) {
		const priv = this.crypto.privFromMnemonic(mnemonic);
		const pub = this.crypto.pubFromMnemonic(mnemonic);

		let { me } = await this.me();
		let publicKey = me && me.publicKey;
		let publicKeys = me && me.publicKeys;

		if (!publicKeys) {
			return;
		}

		if (publicKey && publicKey !== pub) {
			return; // seed changed
		}

		publicKeys = publicKeys.nodes.filter(
			e =>
				!e.encryptedMnemonic &&
				e.address &&
				e.address.includes('@') &&
				!['handcash', 'TwetchWallet'].includes(e.walletType)
		);

		for (let each of publicKeys) {
			let data = mnemonic;

			let identityPublicKey = each.identityPublicKey;

			if (!identityPublicKey) {
				let url;

				if (each.address.includes('relayx.io')) {
					url = 'https://relayx.io/bsvalias/id/';
				}

				if (each.address.includes('moneybutton.com')) {
					url = 'https://moneybutton.com/api/v1/bsvalias/id/';
				}

				const { data: bsvalias } = await axios.get(
					`https://cloud-functions.twetch.app/api/bsvalias?address=${each.address}`
				);

				identityPublicKey = bsvalias.pubkey;
			}

			if (each.walletType === 'onebutton') {
				data = `1harryntQnTKu5RGajGokZGqP2v8mZKJm::${data}`;
			}

			const encryptedMnemonic = this.crypto.eciesEncrypt(data, identityPublicKey);
			await this.updatePublicKey(each.id, { encryptedMnemonic, identityPublicKey });
		}

		if (!publicKey) {
			await this.updateMe({ publicKey: pub });
		}

		if (!me.xpub) {
			const xpub = this.crypto.xpubFromMnemonic(mnemonic);
			await this.updateMe({ xpub });
		}

		return mnemonic;
	}

	async authenticate(options = {}) {
		let token = this.storage.getItem('tokenTwetchAuth');

		if (!this.authenticated) {
			const authApi = new AuthApi();
			const message = await authApi.challenge();
			const signature = this.wallet.sign(message);
			const address = this.wallet.address();
			token = await authApi.authenticate({ message, signature, address, v2: !!options.create });
		}

		this.storage.setItem('tokenTwetchAuth', token);
		this.client = axios.create({
			baseURL: this.options.apiUrl || 'https://api.twetch.app/v1',
			headers: {
				Authorization: `Bearer ${this.storage.getItem('tokenTwetchAuth')}`
			}
		});
		this.authenticated = true;
		return token;
	}

	async query(query, variables = {}) {
		const response = await this.client.post('/graphql', {
			variables,
			query
		});

		return response.data.data;
	}

	me() {
		return this.query(`
			query {
				me {
					id
					name
					publicKey
					xpub
					publicKeys: publicKeysByUserId(filter: { revokedAt: { isNull: true } }) {
						nodes {
							id
							walletType
							signingAddress
							identityPublicKey
							encryptedMnemonic
							address
						}
					}
				}
			}
		`);
	}

	async updateMe(payload) {
		const { me } = await this.me();
		return this.query(
			`
			mutation updateUser($payload: UserPatch!, $id: BigInt!) {
				updateUserById(input: {userPatch: $payload, id: $id}) {
					clientMutationId
				}
			}
		`,
			{ payload, id: me.id }
		);
	}

	async updatePublicKey(id, payload) {
		return this.query(
			`
			mutation updatePublicKey($payload: PublicKeyPatch!, $id: UUID!) {
				updatePublicKeyById(input: {publicKeyPatch: $payload, id: $id}) {
					clientMutationId
				}
			}
		`,
			{ payload, id }
		);
	}

	async init() {
		console.log(
			`1) copy the following to add as a signing address on https://twetch.app/developer`
		);
		const message = 'twetch-api-rocks';
		console.log('\nbsv address: ', this.wallet.address());
		console.log('message: ', message);
		console.log('signature: ', this.wallet.sign(message));
		console.log('\n');
		console.log(`2) fund your address with some BSV (${this.wallet.address()})`);
	}

	async initAbi() {
		this.abi = JSON.parse(this.storage.getItem('abi') || '{}');
		this.abi = await this.fetchABI();
		this.storage.setItem('abi', JSON.stringify(this.abi));
	}

	async publish(action, payload, file) {
		try {
			console.log('signing address: ', this.wallet.address());

			const balance = await this.wallet.balance();

			if (!balance) {
				return console.log('No Funds. Please add funds to ', this.wallet.address());
			}

			console.log('balance: ', balance / 100000000, 'BSV');

			return this.buildAndPublish(action, payload, file);
		} catch (e) {
			return handleError(e);
		}
	}

	async build(action, payload, file, clientIdentifier) {
		try {
			if (!this.abi || !this.abi.name) {
				await this.initAbi();
			}

			const abi = new BSVABI(this.abi, {
				network: this.network,
				action
			});

			if (file) {
				abi.fromFile(file);
			}
			abi.fromObject(payload);

			if (!this.authenticated) {
				await this.authenticate();
			}

			const payeeResponse = await this.fetchPayees({
				args: abi.toArray(),
				action,
				clientIdentifier
			});
			this.invoice = payeeResponse.invoice;
			await abi.replace({
				'#{invoice}': () => payeeResponse.invoice
			});

			return { abi, ...payeeResponse };
		} catch (e) {
			return handleError(e);
		}
	}

	async buildAndPublish(action, payload, file) {
		try {
			const { abi, payees, invoice } = await this.build(action, payload, file);
			await abi.replace({
				'#{mySignature}': () => this.wallet.sign(abi.contentHash()),
				'#{myAddress}': () => this.wallet.address()
			});
			const tx = await this.wallet.buildTx(abi.toArray(), payees, action);

			if (this.wallet.canPublish) {
				return { txid: tx.hash, abi };
			}

			new BSVABI(this.abi, { network: this.network }).action(action).fromTx(tx.toString());
			const response = await this.publishRequest({
				signed_raw_tx: tx.toString(),
				invoice,
				action,
				payParams: payload.payParams,
				broadcast: true
			});
			return { ...response, txid: tx.hash, abi };
		} catch (e) {
			return handleError(e);
		}
	}

	async fetchABI() {
		const response = await this.client.get('/abi');
		return response.data;
	}

	async fetchPayees(payload) {
		const clientIdentifier = Object.assign(payload.clientIdentifier || this.clientIdentifier);
		delete payload.clientIdentifier;
		const response = await this.client.post('/payees', {
			...payload,
			client_identifier: clientIdentifier
		});
		return response.data;
	}

	async publishRequest(payload) {
		try {
			const response = await this.client.post('/publish', payload);
			return response.data;
		} catch (e) {
			if (e && e.response) {
				throw { response: { data: e.response.data } };
			}

			throw e;
		}
	}

	async bsvPrice() {
		const { data } = await axios.get('https://cloud-functions.twetch.app/api/exchange-rate');
		return data.price;
	}
}

function handleError(e) {
	if (e && e.response && e.response.data) {
		if (e.response.data.errors) {
			return { error: e.response.data.errors.join(', ') };
		}

		if (e.response.status === 401) {
			return { error: 'unauthenticated' };
		}
	} else if (e.toString) {
		console.log(e.toString());
		return { error: e.toString() };
	} else {
		return { error: e };
		console.log(e);
	}

	return { error: 'something went wrong' };
}

module.exports = Client;
