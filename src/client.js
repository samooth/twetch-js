const BSVABI = require('../bsvabi/bsvabi');
const axios = require('axios');

const Storage = require('./storage');
const Wallet = require('./wallet');
const AuthApi = require('../shared-helpers/auth-api');

class Client {
	constructor(options = {}) {
		this.options = options;
		this.storage = new Storage(options);
		this.clientIdentifier = options.clientIdentifier || 'e4c86c79-3eec-4069-a25c-8436ba8c6009';
		this.network = options.network || 'mainnet';
		this.wallet = options.Wallet ? new options.Wallet(options) : new Wallet(options);
		this.client = axios.create({ baseURL: options.apiUrl || 'https://api.twetch.app/v1' });
		this.initAbi();
	}

	get BSVABI() {
		return BSVABI;
	}

	async authenticate() {
		let token = this.storage.getItem('tokenTwetchAuth');

		if (!token) {
			const authApi = new AuthApi();
			const message = await authApi.challenge();
			const signature = this.wallet.sign(message);
			const address = this.wallet.address();
			token = await authApi.authenticate({ message, signature, address });
		}

		this.client = axios.create({
			baseURL: this.options.apiUrl || 'https://api.twetch.app/v1',
			headers: {
				Authorization: `Bearer ${token}`
			}
		});
		this.storage.setItem('tokenTwetchAuth', token);
		return token;
	}

	async query(query, variables = {}) {
		const response = await this.client.post('/graphql', {
			operationName: 'me',
			variables,
			query
		});

		return response;
	}

	async me() {
		const response = await this.query(`
			query me {
				me {
					id
				}
			}
		`);

		return response.data;
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

	async build(action, payload, file) {
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

			const payeeResponse = await this.fetchPayees({ args: abi.toArray(), action });
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
				payParams: payload.payParams
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
		const response = await this.client.post('/payees', {
			...payload,
			client_identifier: this.clientIdentifier
		});
		return response.data;
	}

	async publishRequest(payload) {
		const response = await this.client.post('/publish', payload);
		return response.data;
	}
}

function handleError(e) {
	if (e && e.response && e.response.data) {
		console.log(e.response.data);
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
