const http = require('http');
const https = require('https');
// const followRedirects = require('follow-redirects');
const mime = require('mime');
const AWS = require('aws-sdk');
/* const flow = {
  sdk: require('@onflow/sdk'),
  types: require('@onflow/types'),
}; */
const Discord = require('discord.js');
// const blockchain = require('./blockchain.js');
const fetch = require('node-fetch');
// const wordList = require('./wordlist.json');
// const config = require('./config.json');
// const flowConstants = require('./flow-constants.js');
const Web3 = require('web3');
const bip39 = require('bip39');
const {Transaction} = require('@ethereumjs/tx');
const {default: Common} = require('@ethereumjs/common');
const {hdkey} = require('ethereumjs-wallet');

const {accessKeyId, secretAccessKey, discordApiToken, mnemonic, infuraProjectId, treasuryMnemonic} = require('../exokit-backend/config.json');
const awsConfig = new AWS.Config({
  credentials: new AWS.Credentials({
    accessKeyId,
    secretAccessKey,
  }),
  region: 'us-west-1',
});
const ddb = new AWS.DynamoDB(awsConfig);
const ddbd = new AWS.DynamoDB.DocumentClient(awsConfig);
// const guildId = '433492168825634816';
// const channelName = 'token-hax';
const adminUserId = '284377201233887233';
const usersTableName = 'users';
const storeTableName = 'store';
const prefix = '.';
const storageHost = 'https://storage.exokit.org';
const previewHost = 'https://preview.exokit.org';
const previewExt = 'png';
const treasurerRoleName = 'Treasurer';
const treasuryWallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(treasuryMnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
const treasuryAddress = treasuryWallet.getAddressString();

Error.stackTraceLimit = 300;

function getExt(fileName) {
  const match = fileName.match(/\.([^\.]+)$/);
  return match && match[1].toLowerCase();
}

const _runTransaction = async (userKeys, transaction) => {
  const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
    method: 'POST',
    body: JSON.stringify({
      address: userKeys.address,
      privateKey: userKeys.privateKey,
      publicKey: userKeys.publicKey,
      mnemonic: userKeys.mnemonic,

      limit: 100,
      transaction,
      wait: true,
    }),
  });
  const response2 = await res.json();

  // console.log('bake contract 2', response2);
  return response2;
};
const _runScript = async script => {
  const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
    method: 'POST',
    body: JSON.stringify({
      limit: 100,
      script,
      wait: true,
    }),
  });
  const response2 = await res.json();

  // console.log('bake contract 2', response2);
  return response2;
};
const _runSpec = async (userKeys, spec) => {
  const {transaction, script, args} = spec;
  const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
    method: 'POST',
    body: JSON.stringify({
      address: userKeys.address,
      privateKey: userKeys.privateKey,
      publicKey: userKeys.publicKey,
      mnemonic: userKeys.mnemonic,

      limit: 100,
      transaction,
      script,
      args,
      wait: true,
    }),
  });
  const response2 = await res.json();

  // console.log('bake contract 2', response2);
  return response2;
};
const _readStorageHashAsBuffer = async hash => {
  const bs = [];
  const req = await fetch(`${storageHost}/${hash}`);
  if (req.ok) {
    const arrayBuffer = await req.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer;
  } else {
    return null;
  }
};
const makePromise = () => {
  let accept, reject;
  const p = new Promise((a, r) => {
    accept = a;
    reject = r;
  });
  p.accept = accept;
  p.reject = reject;
  return p;
};

(async () => {
  const web3 = new Web3(new Web3.providers.HttpProvider('http://13.56.80.83:8545'));
  const addresses = await fetch('https://contracts.webaverse.com/ethereum/address.js').then(res => res.text()).then(s => JSON.parse(s.replace(/^\s*export\s*default\s*/, '')).sidechain);
  const abis = await fetch('https://contracts.webaverse.com/ethereum/abi.js').then(res => res.text()).then(s => JSON.parse(s.replace(/^\s*export\s*default\s*/, '')));
  // const chainIds = await fetch('https://contracts.webaverse.com/ethereum/chain-id.js').then(res => res.text()).then(s => JSON.parse(s.replace(/^\s*export\s*default\s*/, '')).sidechain);
  const contracts = await (async () => {
    console.log('got addresses', addresses);
    const result = {};
    [
      'Account',
      'FT',
      'NFT',
      'FTProxy',
      'NFTProxy',
      'Trade',
    ].forEach(contractName => {
      result[contractName] = new web3.eth.Contract(abis[contractName], addresses[contractName]);
    });
    return result;
  })();
  // const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
  // const address = wallet.getAddressString();
  
  const trades = [];
  // const stores = [];
  const helps = [];
  let nextTradeId = 0;

  const getStores = async () => {
    const numStores = await contracts.Trade.methods.numStores().call();
    const booths = [];
    for (let i = 0; i < numStores; i++) {
      const store = await contracts.Trade.methods.getStoreByIndex(i + 1).call();
      if (store.live) {
        const id = parseInt(store.id, 10);
        const seller = store.seller.toLowerCase();
        const tokenId = parseInt(store.tokenId, 10);
        const price = new web3.utils.BN(store.price);
        const entry = {
          id,
          seller,
          tokenId,
          price,
        };
        
        // console.log('got store', store, entry);
        
        let booth = booths.find(booth => booth.seller === seller);
        if (!booth) {
          booth = {
            seller,
            entries: [],
          };
          booths.push(booth);
        }
        booth.entries.push(entry);
      }
    }
    // console.log('got stores', stores);
    return booths;
  };

  const txQueues = [];
  const runSidechainTransaction = mnemonic => {
    const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
    const address = wallet.getAddressString();

    const fn = async (contractName, method, ...args) => {
      let entry = txQueues[address];
      if (!entry) {
        entry = {
          running: false,
          cbs: [],
        };
        txQueues[address] = entry;
      }
      if (!entry.running) {
        entry.running = true;
        
        try {
          // console.log('run tx', contracts['sidechain'], [contractName, method]);
          const txData = contracts[contractName].methods[method](...args);
          const data = txData.encodeABI();
          const gas = await txData.estimateGas({
            from: address,
          });
          let gasPrice = await web3.eth.getGasPrice();
          gasPrice = parseInt(gasPrice, 10);

          const privateKey = wallet.getPrivateKeyString();
          const nonce = await web3.eth.getTransactionCount(address);
          const privateKeyBytes = Uint8Array.from(web3.utils.hexToBytes(privateKey));

          let tx = Transaction.fromTxData({
            to: contracts[contractName]._address,
            nonce: '0x' + new web3.utils.BN(nonce).toString(16),
            // gas: '0x' + new web3.utils.BN(gasPrice).toString(16),
            gasPrice: '0x' + new web3.utils.BN(gasPrice).toString(16),
            gasLimit: '0x' + new web3.utils.BN(8000000).toString(16),
            data,
          }, {
            common: Common.forCustomChain(
              'mainnet',
              {
                name: 'geth',
                networkId: 1,
                chainId: 1337,
              },
              'petersburg',
            ),
          }).sign(privateKeyBytes);
          const rawTx = '0x' + tx.serialize().toString('hex');

          const receipt = await web3.eth.sendSignedTransaction(rawTx);
          
          return receipt;
        } finally {
          entry.running = false;

          if (entry.cbs.length > 0) {
            entry.cbs.shift()();
          }
        }
      } else {
        const p = makePromise();
        entry.cbs.push(async () => {
          try {
            const result = await fn(contractName, method, ...args);
            p.accept(result);
          } catch(err) {
            p.reject(err);
          }
        });
        return await p;
      }
    };
    return fn;
  };

  const client = new Discord.Client();

  client.on('ready', async function() {
    console.log(`the client becomes ready to start`);
    console.log(`I am ready! Logged in as ${client.user.tag}!`);
    console.log(`Bot has started, with ${client.users.size} users, in ${client.channels.size} channels of ${client.guilds.size} guilds.`);

    // console.log('got', client.guilds.cache.get(guildId).members.cache);

    client.on('messageReactionAdd', async (reaction, user) => {
      const {data, message, emoji} = reaction;
      // console.log('emoji identifier', message, data, emoji);
      if (user.id !== client.user.id && emoji.identifier === '%E2%9D%8C') { // x
        if (message.channel.type === 'dm') {
          message.delete();
        } else {
          const helpIndex = helps.findIndex(help => help.id === message.id);
          if (helpIndex !== -1) {
            const help = helps[helpIndex];
            if (help.requester.id === user.id) {
              help.delete();
              helps.splice(helpIndex, 1);
            }
          }
        }
      } else if (user.id !== client.user.id && emoji.identifier === '%E2%9C%85') { // white check mark
        const trade = trades.find(trade => trade.id === message.id);
        if (trade) {
          const index = trade.userIds.indexOf(user.id);
          if (index >= 0) {
            trade.confirmations[index] = true;
            trade.render();
 
            if (trade.confirmations.every(confirmation => !!confirmation)) {
              if (trade.confirmations2.every(confirmation => !!confirmation)) {
                trade.finish();
                trades.splice(trades.indexOf(trade), 1);
              } else {
                trade.react('💞');
              }
            }
          }
        }
      } else if (user.id !== client.user.id && emoji.identifier === '%F0%9F%92%9E') { // rotating hearts
        const trade = trades.find(trade => trade.id === message.id);
        if (trade) {
          const index = trade.userIds.indexOf(user.id);
          if (index >= 0) {
            trade.confirmations2[index] = true;
            trade.render();
 
            if (trade.confirmations.every(confirmation => !!confirmation) && trade.confirmations2.every(confirmation => !!confirmation)) {
              trade.finish();
              trades.splice(trades.indexOf(trade), 1);
            }
          }
        }
      } else if (user.id !== client.user.id && emoji.identifier === '%E2%9D%8C') { // x
        const trade = trades.find(trade => trade.id === message.id);
        if (trade) {
          const index = trade.userIds.indexOf(user.id);
          if (index >= 0) {
            trade.cancel();
            trades.splice(trades.indexOf(trade), 1);
          }
        }
      }
    });
    client.on('messageReactionRemove', async (reaction, user) => {
      const {data, message, emoji} = reaction;
      if (user.id !== client.user.id && emoji.identifier === '%E2%9C%85') { // white check mark
        const trade = trades.find(trade => trade.id === message.id);
        if (trade) {
          const index = trade.userIds.indexOf(user.id);
          if (index >= 0) {
            trade.confirmations[index] = false;
            trade.render();
            
            const doneReactions = trade.reactions.cache.filter(reaction => reaction.emoji.identifier === '%F0%9F%92%9E');
            // console.log('got done reactions', Array.from(doneReactions.values()).length);
            try {
              for (const reaction of doneReactions.values()) {
                const users = Array.from(reaction.users.cache.values());
                console.log('got reaction users', users.map(u => u.id));
                for (const user of users) {
                  await reaction.users.remove(user.id);
                }
              }
            } catch (error) {
              console.error('Failed to remove reactions.', error.stack);
            }
          }
        }
      }
    });
    client.on('message', async message => {
      if (!message.author.bot) {
        const _getUser = async (id = message.author.id) => {
          const tokenItem = await ddb.getItem({
            TableName: usersTableName,
            Key: {
              email: {S: id + '.discordtoken'},
            }
          }).promise();

          let mnemonic = (tokenItem.Item && tokenItem.Item.mnemonic) ? tokenItem.Item.mnemonic.S : null;
          return {mnemonic};
        };
        const _genKey = async (id = message.author.id) => {
          const mnemonic = bip39.generateMnemonic();

          await ddb.putItem({
            TableName: usersTableName,
            Item: {
              email: {S: id + '.discordtoken'},
              mnemonic: {S: mnemonic},
            }
          }).promise();
          return {mnemonic};
        };
        /* const _ensureBaked = async ({addr, mnemonic}) => {
          const contractSource = await blockchain.getContractSource('isUserAccountBaked.cdc');

          const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
            method: 'POST',
            body: JSON.stringify({
              limit: 100,
              script: contractSource.replace(/ARG0/g, '0x' + addr),
              wait: true,
            }),
          });
          const response = await res.json();
          const isBaked = response.encodedData.value;
          if (!isBaked) {
            const contractSources = await blockchain.getContractSource('bakeUserAccount.json');
            for (const contractSource of contractSources) {
              contractSource.address = addr;
              contractSource.mnemonic = mnemonic;
              contractSource.limit = 100;
              contractSource.wait = true;

              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify(contractSource),
              });
              
              const response = await res.json();
              console.log('baked account result', response);
            }
          }
        }; */

        if (message.channel.type === 'text') {
          // console.log('got message', message);

          /* if (/grease/.test(message.content)) {
            message.author.send('i am NOT grease?!!!!');
          } */
          const split = message.content.split(/\s+/);
          let match;
          if (split[0] === prefix + 'help') {
            const m = await message.channel.send(`\`\`\`\
Info
.status - show your account details
.balance - show your FT balance, or that of a user/address
.inventory [@user|0xaddr]? - show your NFTs, or those of a user/address
.address [@user]? - print your address, or that of a user
.key - get your private key in a DM
     - can be used to log into the app

Tokens
.send [@user|0xaddr|treasury] [amount] - send [amount] FT to user/address
.transfer [@user|0xaddr|treasury] [id] [quantity]? - send [quantity] [id] NFTs to user/addr/treasury
.preview [id] - show preview of NFT [id] in channel
.gif [id] - show animated gif of NFT [id] in channel
.wget [id] - get NFT [id] delivered in DM
.get [id] [key] - get metadata key [key] for NFT [id]
.set [id] [key] [value] - set metadata key [key] to [value] for NFT [id]

Account
.name [newname] - set your name to [name] on the chain
.avatar [id] - set your avatar to [id] on the chain

Minting
.mint [count]? (in the file upload comment) - mint [count] NFTs from file upload
.mint [count]? [url] - mint [count] NFTs from the provided [url]

Packing
.packs [@user|nftid] - check packed ft balances of [@user] or [nftid]
.pack [nftid] [amount] - pack [amount] ft from yourself into [nftid]
.unpack [nftid] [amount] - unpack [amount] ft from [nftid] to yourself

Trade
.trade [@user|0xaddr] - start a trade with user/address
.addnft [tradeid] [nftid] - add nonfungible token to trade [tradeid]
.removenft [tradeid] [index] - remove nonfungible token at [index] from trade [tradeid]
.addft [tradeid] [amount] - add fungible tokens to trade [tradeid]

Store
.store [@user]? - show the treasury store, or that of a user
.sell [nftid] [price] - list [nftid] for sale at [price]
.unsell [saleid] - unlist [saleid] from the store
.buy [saleid] - buy the [saleid] from [@user]

Key Management (DM to bot)
.key [new mnemonic key] - set your Discord private key
.key reset - generate and set a new Discord private key

Help
.help - show this info
\`\`\``);

            m.react('❌');
            m.requester = message.author;
            helps.push(m);
          } else if (split[0] === prefix + 'status') {
            let userId, mnemonic;
            if (split.length >= 2 && (match = split[1].match(/<@!([0-9]+)>/))) {
              userId = match[1];
            } else {
              userId = message.author.id;
            }
            const spec = await _getUser(userId);
            mnemonic = spec.mnemonic;
            if (!mnemonic) {
              const spec = await _genKey(userId);
              mnemonic = spec.mnemonic;
            }

            const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
            const address = wallet.getAddressString();
            const name = await contracts.Account.methods.getMetadata(address, 'name').call();
            const avatarUrl = await contracts.Account.methods.getMetadata(address, 'avatarUrl').call();

            /* const contractSource = await blockchain.getContractSource('getUserData.cdc');

            const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
              method: 'POST',
              body: JSON.stringify({
                limit: 100,
                script: contractSource.replace(/ARG0/g, '0x' + addr),
                wait: true,
              }),
            });
            const response2 = await res.json();
            const [name, avatarUrl] = response2.encodedData.value.map(value => value.value && value.value.value); */

            message.channel.send('<@!' + message.author.id + '>: ' + `\`\`\`Name: ${name}\nAvatar: ${avatarUrl}\n\`\`\``);
          } else if (split[0] === prefix + 'name') {
            let {mnemonic} = await _getUser();
            if (!mnemonic) {
              const spec = await _genKey();
              mnemonic = spec.mnemonic;
            }

            if (split[1]) {
              const name = split[1];

              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              const result = await runSidechainTransaction(mnemonic)('Account', 'setMetadata', address, 'name', name);
              
              /* const contractSource = await blockchain.getContractSource('setUserData.cdc');
              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  address: addr,
                  mnemonic,

                  limit: 100,
                  transaction: contractSource
                    .replace(/ARG0/g, 'name')
                    .replace(/ARG1/g, name),
                  wait: true,
                }),
              });
              const response2 = await res.json(); */

              message.channel.send('<@!' + message.author.id + '>: set name to ' + JSON.stringify(name));
            } else {
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              const name = await contracts.Account.methods.getMetadata(address, 'name').call();
              
              /* const contractSource = await blockchain.getContractSource('getUserData.cdc');

              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  limit: 100,
                  script: contractSource.replace(/ARG0/g, '0x' + addr),
                  wait: true,
                }),
              });
              const response2 = await res.json();
              const [name, avatarUrl] = response2.encodedData.value.map(value => value.value && value.value.value); */

              message.channel.send('<@!' + message.author.id + '>: name is ' + JSON.stringify(name));
            }
          } else if (split[0] === prefix + 'avatar') {
            let {mnemonic} = await _getUser();
            if (!mnemonic) {
              const spec = await _genKey();
              mnemonic = spec.mnemonic;
            }

            const id = parseInt(split[1], 10);

            if (!isNaN(id)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              
              const hashNumberString = await contracts.NFT.methods.getHash(id).call();
              const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
              const filename = await contracts.NFT.methods.getMetadata(hash, 'filename').call();
              const match = filename.match(/^(.+)\.([^\.]+)$/);
              const ext = match ? match[2] : '';

              const avatarUrl = `${storageHost}/${hash.slice(2)}${ext ? ('.' + ext) : ''}`;
              const avatarPreview = `${previewHost}/${hash.slice(2)}${ext ? ('.' + ext) : ''}/preview.${previewExt}`;
              
              await runSidechainTransaction(mnemonic)('Account', 'setMetadata', address, 'avatarUrl', avatarUrl);
              await runSidechainTransaction(mnemonic)('Account', 'setMetadata', address, 'avatarFileName', avatarUrl);
              await runSidechainTransaction(mnemonic)('Account', 'setMetadata', address, 'avatarPreview', avatarPreview);

              message.channel.send('<@!' + message.author.id + '>: set avatar to ' + id);
            } else {
              /* const contractSource = await blockchain.getContractSource('getUserData.cdc');

              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  limit: 100,
                  script: contractSource.replace(/ARG0/g, '0x' + addr),
                  wait: true,
                }),
              });
              const response2 = await res.json();
              const [name, avatarUrl] = response2.encodedData.value.map(value => value.value && value.value.value); */
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              const avatarUrl = await contracts.Account.methods.getMetadata(address, 'avatarUrl').call();

              message.channel.send('<@!' + message.author.id + '>: avatar is ' + JSON.stringify(avatarUrl));
            }
          } else if (split[0] === prefix + 'balance') {
            let match;
            if (split.length >= 2 && (match = split[1].match(/<@!([0-9]+)>/))) {
              const userId = match[1];
              let {mnemonic} = await _getUser(userId);
              if (!mnemonic) {
                const spec = await _genKey(userId);
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              const balance = await contracts.FT.methods.balanceOf(address).call();

              /* const contractSource = await blockchain.getContractSource('getBalance.cdc');

              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  address: addr,
                  mnemonic,

                  limit: 100,
                  script: contractSource.replace(/ARG0/g, '0x' + addr),
                  wait: true,
                }),
              });
              const response2 = await res.json();
              const balance = parseFloat(response2.encodedData.value); */

              message.channel.send('<@!' + userId + '> has ' + balance + ' grease');
            } else if (split[1] === 'treasury') {
              const balance = await contracts.FT.methods.balanceOf(treasuryAddress).call();

              /* const contractSource = await blockchain.getContractSource('getBalance.cdc');

              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  address: addr,
                  mnemonic,

                  limit: 100,
                  script: contractSource.replace(/ARG0/g, '0x' + addr),
                  wait: true,
                }),
              });
              const response2 = await res.json();
              const balance = parseFloat(response2.encodedData.value); */

              message.channel.send('treasury has ' + balance + ' grease');
            } else {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              const balance = await contracts.FT.methods.balanceOf(address).call();

              /* const contractSource = await blockchain.getContractSource('getBalance.cdc');

              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  address: addr,
                  mnemonic,

                  limit: 100,
                  script: contractSource.replace(/ARG0/g, '0x' + addr),
                  wait: true,
                }),
              });
              const response2 = await res.json();
              const balance = parseFloat(response2.encodedData.value); */

              message.channel.send('<@!' + message.author.id + '> has ' + balance + ' grease');
            }
          } else if (split[0] === prefix + 'address') {
            let user, address, userLabel;
            if (split[1] !== 'treasury') {
              if (split[1] && (match = split[1].match(/<@!([0-9]+)>/))) {
                const userId = match[1];
                const member = await message.channel.guild.members.fetch(userId);
                user = member ? member.user : null;
              } else {
                user = message.author;
              }
              let mnemonic;
              const spec = await _getUser(user.id);
              if (spec.mnemonic) {
                mnemonic = spec.mnemonic;
              } else {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              address = wallet.getAddressString();

              userLabel = '<@!' + user.id + '>';
            } else {
              address = treasuryAddress;
              userLabel = 'treasury';
            }

            if (address) {
              message.channel.send(userLabel + '\'s address: ```' + address + '```');
            } else {
              message.channel.send('no such user');
            }
          /* } else if (split[0] === prefix + 'mint' && message.author.id === adminUserId && message.attachments.size === 0) {
            let amount = parseFloat(split[1]);
            if (isNaN(amount)) {
              amount = 1;
            }
            let {mnemonic} = await _getUser();
            if (!mnemonic) {
              const spec = await _genKey();
              mnemonic = spec.mnemonic;
            }
            
            const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
            const address = wallet.getAddressString();
            // const balance = await contracts.FT.methods.balanceOf(address).call();
            const result = await runSidechainTransaction(mnemonic)('FT', 'mint', address, amount);

            if (!response2.transaction.errorMessage) {
              message.channel.send('<@!' + message.author.id + '>: minted ' + amount);
            } else {
              message.channel.send('<@!' + message.author.id + '>: could not mint: ' + response2.transaction.errorMessage);
            } */
          } else if (split[0] === prefix + 'send' && split.length >= 3 && !isNaN(parseFloat(split[2]))) {
            const amount = parseFloat(split[2]);
            if (match = split[1].match(/<@!([0-9]+)>/)) {
              const userId = match[1];
              const member = await message.channel.guild.members.fetch(userId);
              const user = member ? member.user : null;
              if (user) {
                let mnemonic, mnemonic2;
                if (userId !== message.author.id) {
                  {
                    const userSpec = await _getUser();
                    mnemonic = userSpec.mnemonic;
                    if (!mnemonic) {
                      const spec = await _genKey();
                      mnemonic = spec.mnemonic;
                    }
                  }
                  {
                    const userSpec = await _getUser(user.id);
                    mnemonic2 = userSpec.mnemonic;
                    if (!mnemonic2) {
                      const spec = await _genKey(userId);
                      mnemonic2 = spec.mnemonic;
                    }
                  }
                } else {
                  const treasurer = member.roles.cache.some(role => role.name === treasurerRoleName);
                  if (treasurer) {
                    mnemonic = treasuryMnemonic;
                    {
                      const userSpec = await _getUser();
                      mnemonic2 = userSpec.mnemonic;
                      if (!mnemonic2) {
                        const spec = await _genKey();
                        mnemonic2 = spec.mnemonic;
                      }
                    }
                  } else {
                    message.channel.send('<@!' + message.author.id + '>: you are not a treasurer');
                    return;
                  }
                }
                
                const wallet2 = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic2)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                const address2 = wallet2.getAddressString();
 
                let status, transactionHash;
                try {
                  const result = await runSidechainTransaction(mnemonic)('FT', 'transfer', address2, amount);
                  status = result.status;
                  transactionHash = result.transactionHash;
                } catch(err) {
                  console.warn(err.stack);
                  status = false;
                  transactionHash = '0x0';
                }

                /* const contractSource = await blockchain.getContractSource('transferToken.cdc');
                const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                  method: 'POST',
                  body: JSON.stringify({
                    address: addr,
                    mnemonic,

                    limit: 100,
                    transaction: contractSource
                      .replace(/ARG0/g, amount.toFixed(8))
                      .replace(/ARG1/g, '0x' + addr2),
                    wait: true,
                  }),
                });
                const response2 = await res.json(); */

                if (status) {
                  message.channel.send('<@!' + message.author.id + '>: sent ' + amount + ' to <@!' + userId + '>');
                } else {
                  message.channel.send('<@!' + message.author.id + '>: could not send: ' + transactionHash);
                }
              } else {
                message.channel.send('unknown user');
              }
            } else if (match = split[1].match(/(0x[0-9a-f]+)/i)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }

              const address2 = match[1];

              let status, transactionHash;
              try {
                const result = await runSidechainTransaction(mnemonic)('FT', 'transfer', address2, amount);
                status = result.status;
                transactionHash = result.transactionHash;
              } catch(err) {
                console.warn(err.stack);
                status = false;
                transactionHash = '0x0';
              }

              /* const contractSource = await blockchain.getContractSource('transferToken.cdc');
              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  address: addr,
                  mnemonic,

                  limit: 100,
                  transaction: contractSource
                    .replace(/ARG0/g, amount.toFixed(8))
                    .replace(/ARG1/g, '0x' + addr2),
                  wait: true,
                }),
              });
              const response2 = await res.json(); */

              if (status) {
                message.channel.send('<@!' + message.author.id + '>: sent ' + amount + ' to ' + address2);
              } else {
                message.channel.send('<@!' + message.author.id + '>: could not send: ' + transactionHash);
              }
            } else if (split[1] === 'treasury') {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }

              const wallet2 = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(treasuryMnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address2 = wallet2.getAddressString();

              let status, transactionHash;
              try {
                const result = await runSidechainTransaction(mnemonic)('FT', 'transfer', address2, amount);
                status = result.status;
                transactionHash = result.transactionHash;
              } catch(err) {
                console.warn(err.stack);
                status = false;
                transactionHash = '0x0';
              }

              /* const contractSource = await blockchain.getContractSource('transferToken.cdc');
              const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                method: 'POST',
                body: JSON.stringify({
                  address: addr,
                  mnemonic,

                  limit: 100,
                  transaction: contractSource
                    .replace(/ARG0/g, amount.toFixed(8))
                    .replace(/ARG1/g, '0x' + addr2),
                  wait: true,
                }),
              });
              const response2 = await res.json(); */

              if (status) {
                message.channel.send('<@!' + message.author.id + '>: sent ' + amount + ' to treasury');
              } else {
                message.channel.send('<@!' + message.author.id + '>: could not send: ' + transactionHash);
              }
            } else {
              message.channel.send('unknown user');
            }
          } else if (split[0] === prefix + 'trade' && split.length >= 2) {
            if (match = split[1].match(/<@!([0-9]+)>/)) {
              const userId = match[1];
              const member = await message.channel.guild.members.fetch(userId);
              const user = member ? member.user : null;
              if (user) {
                const tradeId = ++nextTradeId;
                const headerLeft = '   Trade #' + tradeId + ' ' + message.author.username;
                const headerMiddle = ' | ';
                const headerRight = user.username;
                const header = headerLeft + headerMiddle + headerRight;
                const userIds = [message.author.id, userId];
                const fts = [0, 0];
                const nfts = [[], []];
                const confirmations = [false, false];
                const confirmations2 = [false, false];
                const cancelledSpec = {cancelled: false};
                const tradingSpec = {trading: false};
                const finishedSpec = {finished: false};
                const _renderFts = () => {
                  let s = '';
                  if (fts.some(ft => ft > 0)) {
                    s += ((fts[0] ? ('+ ' + fts[0]) : '') + Array(headerLeft.length+1).join(' ')).slice(0, headerLeft.length) +
                      headerMiddle +
                      ((fts[1] ? ('+ ' + fts[1]) : '') + Array(headerRight.length+1).join(' ')).slice(0, headerRight.length) +
                      '\n';
                  }
                  return s;
                };
                const _renderNfts = () => {
                  let s = '';
                  const maxNumItems = Math.max(nfts[0].length, nfts[1].length);
                  for (let i = 0; i < maxNumItems; i++) {
                    const rowItems = [nfts[0][i], nfts[1][i]];
                    const label = (i + '.  ').slice(0, 3);
                    s += (label + (rowItems[0] || '') + Array(headerLeft.length+1).join(' ')).slice(0, headerLeft.length) +
                      headerMiddle +
                      ((rowItems[1] || '') + Array(headerRight.length+1).join(' ')).slice(0, headerRight.length) +
                      '\n';
                  }
                  return s;
                };
                const _renderConfirmations = () => {
                  return ((confirmations[0] ? 'OK' : '') + Array(headerLeft.length+1).join(' ')).slice(0, headerLeft.length) +
                    Array(headerMiddle.length+1).join(' ') +
                    ((confirmations[1] ? 'OK' : '') + Array(headerRight.length+1).join(' ')).slice(0, headerLeft.length) +
                    '\n';
                };
                const _renderStatus = () => {
                  return (cancelledSpec.cancelled ? '[CANCELLED]\n' : '') +
                    (tradingSpec.trading ? '[TRADING...]\n' : '') +
                    (finishedSpec.finished ? '[FINISHED]\n' : '');
                };
                const _render = () => {
                  return '```' + header + '\n' + Array(header.length+1).join('-') + '\n' + _renderFts() + _renderNfts() + _renderConfirmations() + _renderStatus() + '```'
                };
                const m = await message.channel.send(_render());
                m.react('✅')
                  .then(() => m.react('❌'));
                m.tradeId = tradeId;
                m.userIds = userIds;
                m.fts = fts;
                m.nfts = nfts;
                m.confirmations = confirmations;
                m.confirmations2 = confirmations2;
                m.cancelledSpec = cancelledSpec;
                m.tradingSpec = tradingSpec;
                m.finishedSpec = finishedSpec;
                m.addFt = (userId, amount) => {
                  const index = userIds.indexOf(userId);
                  if (index >= 0) {
                    m.fts[index] = amount;
                    m.render();
                  }
                };
                m.addNft = (userId, item) => {
                  const index = userIds.indexOf(userId);
                  if (index >= 0) {
                    m.nfts[index].push(item);
                    m.render();
                  }
                };
                m.removeNft = (userId, itemNumber) => {
                  const index = userIds.indexOf(userId);
                  if (index >= 0) {
                    m.nfts[index].splice(itemNumber, 1);
                    m.render();
                  }
                };
                m.render = () => {
                  m.edit(_render());
                };
                m.cancel = () => {
                  cancelledSpec.cancelled = true;
                  m.render();
                };
                m.finish = async () => {
                  tradingSpec.trading = true;
                  m.render();
                  
                  const fullAmount = {
                    t: 'uint256',
                    v: new web3.utils.BN(1e9)
                      .mul(new web3.utils.BN(1e9))
                      .mul(new web3.utils.BN(1e9)),
                  };
                  const mnemonics = [];
                  const addresses = [];
                  for (const userId of userIds) {
                    let {mnemonic} = await _getUser(userId);
                    if (!mnemonic) {
                      const spec = await _genKey(userId);
                      mnemonic = spec.mnemonic;
                    }

                    await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['Trade']._address, fullAmount.v);
                    await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);
                    
                    mnemonics.push(mnemonic);
                    const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                    const address = wallet.getAddressString();
                    addresses.push(address);
                  }
                  
                  await runSidechainTransaction(mnemonic)(
                    'Trade',
                    'trade',
                    addresses[0], addresses[1],
                    fts[0] !== undefined ? fts[0] : 0,
                    fts[1] !== undefined ? fts[1] : 0,
                    nfts[0][0] !== undefined ? nfts[0][0] : 0,
                    nfts[1][0] !== undefined ? nfts[1][0] : 0,
                    nfts[0][1] !== undefined ? nfts[0][1] : 0,
                    nfts[1][1] !== undefined ? nfts[1][1] : 0,
                    nfts[0][2] !== undefined ? nfts[0][2] : 0,
                    nfts[1][2] !== undefined ? nfts[1][2] : 0
                  );
                  
                  tradingSpec.trading = false;
                  finishedSpec.finished = true;
                  m.render();
                  
                  message.channel.send('```trade #' + tradeId + ' complete! enjoy!```');
                };
                trades.push(m);
              } else {
                message.channel.send('<@!' + message.author.id + '>: cannot find peer');
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid trade peer: ' + split[1]);
            }
          } else if (split[0] === prefix + 'store') {
            let address;
            if (split.length >= 2 && (match = split[1].match(/<@!([0-9]+)>/))) {
              const userId = match[1];
              let {mnemonic} = await _getUser(userId);
              if (!mnemonic) {
                const spec = await _genKey(userId);
                mnemonic = spec.mnemonic;
              }

              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              address = wallet.getAddressString();
            } else {
              address = treasuryAddress;
            }

            const booths = await getStores();

            let s = '';
            const booth = booths.find(booth => booth.seller === address);
            if (booth && booth.entries.length > 0) {
              try {
                const [filenames, packedBalances] = await Promise.all([
                  Promise.all(booth.entries.map(async entry => {
                    const hashNumberString = await contracts.NFT.methods.getHash(entry.tokenId).call();
                    const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
                    const filename = await contracts.NFT.methods.getMetadata(hash, 'filename').call();
                    return filename;
                  })),
                  Promise.all(booth.entries.map(async entry => {
                    const packedBalance = await contracts.NFT.methods.getPackedBalance(entry.tokenId).call();
                    return packedBalance;
                  })),
                ]);

                s += (booth.seller !== treasuryAddress ? booth.seller : 'treasury') + '\'s store: ```' + booth.entries.map((entry, i) => `#${entry.id}: NFT ${entry.tokenId} (${filenames[i]}${packedBalances[i] > 0 ? (' + ' + packedBalances[i] + ' FT') : ''}) for ${entry.price.toNumber()} FT`).join('\n') + '```';
              } catch(err) {
                console.warn(err);
              }
            } else {
              s += (address !== treasuryAddress ? address : 'treasury') + '\'s store: ```empty```';
            }
            message.channel.send(s);
          /* } else if (split[0] === prefix + 'treasury') {
            const member = await message.channel.guild.members.fetch(message.author.id);
            const treasurer = member.roles.cache.some(role => role.name === treasurerRoleName);
            message.channel.send('treasurer flag: ' + treasurer); */
          } else if (split[0] === prefix + 'sell' && split.length >= 3) {
            const tokenId = split[1];
            let price = parseInt(split[2], 10);
            if (!isNaN(price)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();

              const ownTokenIds = [];
              const nftBalance = await contracts.NFT.methods.balanceOf(address).call();
              for (let i = 0; i < nftBalance; i++) {
                const id = await contracts.NFT.methods.tokenOfOwnerByIndex(address, i).call();
                ownTokenIds.push(id);
              }

              const treasuryTokenIds = [];
              const member = await message.channel.guild.members.fetch(message.author.id);
              const treasurer = member.roles.cache.some(role => role.name === treasurerRoleName);
              if (treasurer) {
                const nftBalance = await contracts.NFT.methods.balanceOf(treasuryAddress).call();
                for (let i = 0; i < nftBalance; i++) {
                  const id = await contracts.NFT.methods.tokenOfOwnerByIndex(treasuryAddress, i).call();
                  treasuryTokenIds.push(id);
                }
              }

              // const store = await getStore();
              if (ownTokenIds.includes(tokenId)) {
                let status, buyId;
                try {
                  await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);
                  // buyId = await contracts.Trade.methods.addStore(tokenId, price).call();
                  const buySpec = await runSidechainTransaction(mnemonic)('Trade', 'addStore', tokenId, price);
                  // console.log('got buy spec', JSON.stringify(buySpec, null, 2));
                  buyId = parseInt(buySpec.logs[0].topics[1]);

                  status = true;
                } catch (err) {
                  console.warn(err.stack);
                  status = false;
                  buyId = -1;
                }

                if (status) {
                  message.channel.send('<@!' + message.author.id + '>: sale #' + buyId + ': NFT ' + tokenId + ' for ' + price + ' FT');
                } else {
                  message.channel.send('<@!' + message.author.id + '>: failed to list nft: ' + tokenId);
                }
              } else if (treasuryTokenIds.includes(tokenId)) {
                let status, buyId;
                try {
                  await runSidechainTransaction(treasuryMnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);
                  const buySpec = await runSidechainTransaction(treasuryMnemonic)('Trade', 'addStore', tokenId, price);
                  buyId = parseInt(buySpec.logs[0].topics[1]);

                  status = true;
                } catch (err) {
                  console.warn(err.stack);
                  status = false;
                  buyId = -1;
                }

                if (status) {
                  message.channel.send('<@!' + message.author.id + '>: sale #' + buyId + ': NFT ' + tokenId + ' for ' + price + ' FT');
                } else {
                  message.channel.send('<@!' + message.author.id + '>: failed to list nft: ' + tokenId);
                }
              } else {
                message.channel.send('<@!' + message.author.id + '>: not your nft: ' + tokenId);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid price: ' + split[2]);
            }
          } else if (split[0] === prefix + 'unsell' && split.length >= 2) {
            const buyId = parseInt(split[1], 10);
            if (!isNaN(buyId)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              // const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              // const address = wallet.getAddressString();
              
              let status;
              try {
                await runSidechainTransaction(mnemonic)('Trade', 'removeStore', buyId);
                
                status = true;
              } catch (err) {
                console.warn(err.stack);
                status = false;
              }

              if (status) {
                message.channel.send('<@!' + message.author.id + '>: unlisted sell ' + buyId);
              } else {
                message.channel.send('<@!' + message.author.id + '>: unlist failed: ' + buyId);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid sell id: ' + split[1]);
            }
          } else if (split[0] === prefix + 'buy' && split.length >= 2) {
            const buyId = parseInt(split[1], 10);

            let {mnemonic} = await _getUser();
            if (!mnemonic) {
              const spec = await _genKey();
              mnemonic = spec.mnemonic;
            }

            const fullAmount = {
              t: 'uint256',
              v: new web3.utils.BN(1e9)
                .mul(new web3.utils.BN(1e9))
                .mul(new web3.utils.BN(1e9)),
            };

            let status, tokenId, price;
            try {
              await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['Trade']._address, fullAmount.v);
              await runSidechainTransaction(mnemonic)('Trade', 'buy', buyId);
              
              const store = await contracts.Trade.methods.getStoreByIndex(buyId).call();
              tokenId = parseInt(store.id, 10);
              // const seller = store.seller.toLowerCase();
              price = new web3.utils.BN(store.price);
              
              status = true;
            } catch (err) {
              console.warn(err.stack);
              status = false;
            }

            if (status) {
              message.channel.send('<@!' + message.author.id + '>: got sale #' + tokenId + ' for ' + price.toNumber() + ' FT. noice!');
            } else {
              message.channel.send('<@!' + message.author.id + '>: buy failed');
            }

            /* let booth = null;
            let entry = null;
            for (const b of store.booths) {
              for (const e of b.entries) {
                if (e.id === buyId) {
                  booth = b;
                  entry = e;
                  break;
                }
              }
              if (entry) {
                break;
              }
            }
            if (entry) {
              if (entry.userId !== message.author.id) {
                const {tokenId, price} = entry;

                let {mnemonic: userMnemonic} = await _getUser();
                if (!userMnemonic) {
                  const spec = await _genKey();
                  userMnemonic = spec.mnemonic;
                }

                let boothMnemonic;
                if (booth.address === treasuryAddress) {
                  boothMnemonic = treasuryMnemonic;
                } else {
                  boothMnemonic = null;
                  const tokenItem = await ddb.query({
                    TableName: usersTableName,
                    IndexName: 'address-index',
                    KeyConditionExpression: "#address = :addr",
                    ExpressionAttributeNames:{
                      '#address': 'address',
                    },
                    ExpressionAttributeValues: {
                      ':addr': {
                        S: booth.address,
                      },
                    },
                  }).promise();
                  if (tokenItem && tokenItem.Items && tokenItem.Items.length) {
                    boothMnemonic = tokenItem.Items[0].mnemonic.S;
                  }
                  if (!boothMnemonic) {
                    message.channel.send('<@!' + message.author.id + '>: failed to look up booth user');
                    return;
                  }
                }

                const mnemonics = [userMnemonic, boothMnemonic];
                const addresses = [];
                for (const mnemonic of mnemonics) {
                  const fullAmount = {
                    t: 'uint256',
                    v: new web3.utils.BN(1e9)
                      .mul(new web3.utils.BN(1e9))
                      .mul(new web3.utils.BN(1e9)),
                  };

                  await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['Trade']._address, fullAmount.v);
                  await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);

                  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                  const address = wallet.getAddressString();
                  addresses.push(address);
                }
                
                let status;
                try {
                  await runSidechainTransaction(mnemonic)(
                    'Trade',
                    'trade',
                    addresses[0], addresses[1],
                    price, 0,
                    0, tokenId,
                    0, 0,
                    0, 0,
                  );
                  
                  status = true;
                } catch (err) {
                  console.warn(err.stack);
                  status = false;
                }

                if (status) {
                  booth.entries.splice(booth.entries.indexOf(entry), 1);
                  await setStore(store);
                  message.channel.send('<@!' + message.author.id + '>: got sale #' + tokenId + ' for ' + price + '. noice!');
                } else {
                  message.channel.send('<@!' + message.author.id + '>: buy failed');
                }
              } else {
                message.channel.send('no such sale for user: ' + buyId);
              }
            } else {
              message.channel.send('invalid buy id');
            } */
          } else if (split[0] === prefix + 'addnft' && split.length >= 3) {
            const tradeId = parseInt(split[1], 10);
            const trade = trades.find(trade => trade.tradeId === tradeId);
            if (trade) {
              const index = trade.userIds.indexOf(message.author.id);
              if (index >= 0) {
                const id = split[2];
                const amount = 1;
                
                if (!trade.nfts[index].includes(id)) {
                  const hashNumberString = await contracts.NFT.methods.getHash(id).call();
                  if (hashNumberString !== '0') {
                    const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
                    
                    let {mnemonic} = await _getUser();
                    if (!mnemonic) {
                      const spec = await _genKey();
                      mnemonic = spec.mnemonic;
                    }
                    const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                    const address = wallet.getAddressString();

                    const balance = await contracts.NFT.methods.balanceOfHash(address, hash).call();

                    if (balance > 0) {
                      if (trade.nfts[index].length < 3) {
                        trade.addNft(message.author.id, id);

                        const doneReactions = trade.reactions.cache.filter(reaction => reaction.emoji.identifier === '%E2%9C%85');
                        try {
                          for (const reaction of doneReactions.values()) {
                            const users = Array.from(reaction.users.cache.values());
                            for (const user of users) {
                              if (user.id !== client.user.id) {
                                await reaction.users.remove(user.id);
                              }
                            }
                          }
                        } catch (error) {
                          console.error('Failed to remove reactions.', error.stack);
                        }
                      } else {
                        message.channel.send('<@!' + message.author.id + '>: too many nfts in trade: ' + split[1]);
                      }
                    } else {
                      message.channel.send('<@!' + message.author.id + '>: not your nft: ' + id);
                    }
                  } else {
                    message.channel.send('<@!' + message.author.id + '>: invalid nft: ' + id);
                  }
                } else {
                  message.channel.send('<@!' + message.author.id + '>: already trading nft: ' + id);
                }
              } else {
                message.channel.send('<@!' + message.author.id + '>: not your trade: ' + split[1]);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid trade: ' + split[1]);
            }
          } else if (split[0] === prefix + 'removenft' && split.length >= 3) {
            const tradeId = parseInt(split[1], 10);
            const trade = trades.find(trade => trade.tradeId === tradeId);
            if (trade) {
              const index = trade.userIds.indexOf(message.author.id);
              if (index >= 0) {
                const itemNumber = parseInt(split[2], 10);
                if (itemNumber >= 0 && itemNumber < trade.nfts.length) {
                  trade.removeNft(message.author.id, itemNumber);
                  
                  const doneReactions = trade.reactions.cache.filter(reaction => reaction.emoji.identifier === '%E2%9C%85');
                  try {
                    for (const reaction of doneReactions.values()) {
                      const users = Array.from(reaction.users.cache.values());
                      for (const user of users) {
                        if (user.id !== client.user.id) {
                          await reaction.users.remove(user.id);
                        }
                      }
                    }
                  } catch (error) {
                    console.error('Failed to remove reactions.', error.stack);
                  }
                } else {
                  message.channel.send('<@!' + message.author.id + '>: invalid trade nft index: ' + split[2]);
                }
              } else {
                message.channel.send('<@!' + message.author.id + '>: not your trade: ' + split[1]);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid trade: ' + split[1]);
            }
          } else if (split[0] === prefix + 'addft' && split.length >= 3) {
            const tradeId = parseInt(split[1], 10);
            const trade = trades.find(trade => trade.tradeId === tradeId);
            if (trade) {
              const index = trade.userIds.indexOf(message.author.id);
              if (index >= 0) {
                const amount = parseFloat(split[2]);
                console.log('got amount', amount);
                if (!isNaN(amount)) {
                  let {mnemonic} = await _getUser();
                  if (!mnemonic) {
                    const spec = await _genKey();
                    mnemonic = spec.mnemonic;
                  }
                  
                  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                  const address = wallet.getAddressString();
                  const balance = await contracts.FT.methods.balanceOf(address).call();
                  
                  console.log('got balance', balance);

                  if (balance >= amount) {
                    trade.addFt(message.author.id, amount);

                    const doneReactions = trade.reactions.cache.filter(reaction => reaction.emoji.identifier === '%E2%9C%85');
                    try {
                      for (const reaction of doneReactions.values()) {
                        const users = Array.from(reaction.users.cache.values());
                        for (const user of users) {
                          if (user.id !== client.user.id) {
                            await reaction.users.remove(user.id);
                          }
                        }
                      }
                    } catch (error) {
                      console.error('Failed to remove reactions.', error.stack);
                    }
                  } else {
                    message.channel.send('<@!' + message.author.id + '>: insufficient ft balance: ' + split[2]);
                  }
                } else {
                  message.channel.send('<@!' + message.author.id + '>: invalid amount: ' + split[2]);
                }
              } else {
                message.channel.send('<@!' + message.author.id + '>: not your trade: ' + split[1]);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid trade: ' + split[1]);
            }
          } else if (split[0] === prefix + 'packs') {
            const tokenId = parseInt(split[1], 10);
            let match;
            if (!isNaN(tokenId)) {
              const packedBalance = await contracts.NFT.methods.getPackedBalance(tokenId).call();
              message.channel.send('<@!' + message.author.id + '>: packed balance of #' + tokenId + ': ' + packedBalance);
            } else {
              let address, userLabel;
              const _loadFromUserId = async userId => {
                const spec = await _getUser(userId);
                let mnemonic = spec.mnemonic;
                if (!mnemonic) {
                  const spec = await _genKey(userId);
                  mnemonic = spec.mnemonic;
                }

                const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                address = wallet.getAddressString();

                userLabel = '<@!' + userId + '>';
              };
              const _loadFromAddress = a => {
                address = a;
                userLabel = '`0x' + a + '`';
              };
              const _loadFromTreasury = () => {
                const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(treasuryMnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                address = wallet.getAddressString();
                userLabel = 'treasury';
              };
              if (split.length >= 2 && (match = split[1].match(/<@!([0-9]+)>/))) {
                await _loadFromUserId(match[1]);
              } else if (split.length >= 2 && (match = split[1].match(/^0x([0-9a-f]+)$/i))) {
                _loadFromAddress(match[1]);
              } else if (split.length >= 2 && split[1] === 'treasury') {
                _loadFromTreasury();
              } else {
                await _loadFromUserId(message.author.id);
              }
              
              const nftBalance = await contracts.NFT.methods.balanceOf(address).call();
              const packedBalances = [];
              for (let i = 0; i < nftBalance; i++) {
                const id = await contracts.NFT.methods.tokenOfOwnerByIndex(address, i).call();
                const packedBalance = await contracts.NFT.methods.getPackedBalance(id).call();
                if (packedBalance > 0) {
                  packedBalances.push({
                    id,
                    packedBalance,
                  });
                }
              }

              let s = userLabel + '\'s packs:\n';
              if (packedBalances.length > 0) {
                s += '```' + packedBalances.map((pack, i) => `${pack.id}. contains ${pack.packedBalance} FT`).join('\n') + '```';
              } else {
                s += '```packs empty```';
              }
              const m = await message.channel.send(s);
              m.react('❌');
              m.requester = message.author;
              helps.push(m);
            }
          } else if (split[0] === prefix + 'pack' && split.length >= 3) {
            const tokenId = parseInt(split[1], 10);
            const amount = parseInt(split[2], 10);
            if (!isNaN(tokenId) && !isNaN(amount)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              
              const fullAmount = {
                t: 'uint256',
                v: new web3.utils.BN(1e9)
                  .mul(new web3.utils.BN(1e9))
                  .mul(new web3.utils.BN(1e9)),
              };

              let status;
              try {
                {
                  const result = await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['NFT']._address, fullAmount.v);
                  status = result.status;
                }
                if (status) {
                  const result = await runSidechainTransaction(mnemonic)('NFT', 'pack', address, tokenId, amount);
                  status = result.status;
                }
              } catch(err) {
                console.warn(err);
              }

              if (status) {
                message.channel.send('<@!' + message.author.id + '>: packed ' + amount + ' into #' + tokenId);
              } else {
                message.channel.send('<@!' + message.author.id + '>: failed to pack FT into NFT: ' + tokenId);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid token id: ' + split[1]);
            }
          } else if (split[0] === prefix + 'unpack' && split.length >= 3) {
            const tokenId = parseInt(split[1], 10);
            const amount = parseInt(split[2], 10);
            if (!isNaN(tokenId) && !isNaN(amount)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              
              const result = await runSidechainTransaction(mnemonic)('NFT', 'unpack', address, tokenId, amount);

              if (result.status) {
                message.channel.send('<@!' + message.author.id + '>: unpacked ' + amount + ' from #' + amount);
              } else {
                message.channel.send('<@!' + message.author.id + '>: failed to unpack FT from NFT: ' + tokenId);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid token id: ' + split[1]);
            }
          } else if (split[0] === prefix + 'transfer' && split.length >= 3) {
            const id = parseInt(split[2], 10);
            if (!isNaN(id)) {
              let quantity = split[3] ? parseInt(split[3], 10) : 1;
              if (!isNaN(quantity)) {
                if (match = split[1].match(/<@!([0-9]+)>/)) {
                  const userId = match[1];
                  const member = await message.channel.guild.members.fetch(userId);
                  const user = member ? member.user : null;
                  if (user) {
                    let mnemonic, mnemonic2;
                    if (userId !== message.author.id) {
                      {
                        const userSpec = await _getUser();
                        mnemonic = userSpec.mnemonic;
                        if (!mnemonic) {
                          const spec = await _genKey();
                          mnemonic = spec.mnemonic;
                        }
                      }
                      {
                        const userSpec = await _getUser(user.id);
                        mnemonic2 = userSpec.mnemonic;
                        if (!mnemonic2) {
                          const spec = await _genKey(userId);
                          mnemonic2 = spec.mnemonic;
                        }
                      }
                    } else {
                      const treasurer = member.roles.cache.some(role => role.name === treasurerRoleName);
                      if (treasurer) {
                        mnemonic = treasuryMnemonic;
                        {
                          const userSpec = await _getUser();
                          mnemonic2 = userSpec.mnemonic;
                          if (!mnemonic2) {
                            const spec = await _genKey();
                            mnemonic2 = spec.mnemonic;
                          }
                        }
                      } else {
                        message.channel.send('<@!' + message.author.id + '>: you are not a treasurer');
                        return;
                      }
                    }
                    
                    const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                    const address = wallet.getAddressString();
                    
                    const wallet2 = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic2)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                    const address2 = wallet2.getAddressString();

                    let status = true, transactionHash;
                    try {
                      const hashNumberString = await contracts.NFT.methods.getHash(id).call();
                      const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);

                      const ids = [];
                      const nftBalance = await contracts.NFT.methods.balanceOf(address).call();
                      for (let i = 0; i < nftBalance; i++) {
                        const id = await contracts.NFT.methods.tokenOfOwnerByIndex(address, i).call();
                        const hashNumberString2 = await contracts.NFT.methods.getHash(id).call();
                        const hash2 = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString2, 10).toString(16), 32);
                        if (hash2 === hash) {
                          ids.push(id);
                        }
                      }
                      ids.sort();
                      
                      if (ids.length >= quantity) {
                        await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);

                        for (let i = 0; i < quantity; i++) {
                          const id = ids[i];
                          const result = await runSidechainTransaction(mnemonic)('NFT', 'transferFrom', address, address2, id);
                          status = status && result.status;
                          transactionHash = result.transactionHash;
                        }
                      } else {
                        status = false;
                        transactionHash = 'insufficient nft balance';
                      }
                    } catch(err) {
                      console.warn(err.stack);
                      status = false;
                      transactionHash = '0x0';
                    }

                    if (status) {
                      message.channel.send('<@!' + message.author.id + '>: transferred ' + id + (quantity > 1 ? `(x${quantity})` : '') + ' to <@!' + userId + '>');
                    } else {
                      message.channel.send('<@!' + message.author.id + '>: could not transfer: ' + transactionHash);
                    }
                  } else {
                    message.channel.send('unknown user');
                  }
                } else if (match = split[1].match(/^(0x[0-9a-f]+)$/i)) {
                  let {mnemonic} = await _getUser();
                  if (!mnemonic) {
                    const spec = await _genKey();
                    mnemonic = spec.mnemonic;
                  }

                  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                  const address = wallet.getAddressString();
                  
                  const address2 = match[1];

                  let status = true;
                  for (let i = 0; i < quantity; i++) {
                    try {
                      await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);
                      
                      const result = await runSidechainTransaction(mnemonic)('NFT', 'transferFrom', address, address2, id);
                      status = status && result.status;
                    } catch(err) {
                      console.warn(err.stack);
                      status = false;
                      break;
                    }
                  }

                  /* const contractSource = await blockchain.getContractSource('transferNft.cdc');
                  const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                    method: 'POST',
                    body: JSON.stringify({
                      address: addr,
                      mnemonic,

                      limit: 100,
                      transaction: contractSource
                        .replace(/ARG0/g, id)
                        .replace(/ARG1/g, '0x' + addr2)
                        .replace(/ARG2/g, quantity),
                      wait: true,
                    }),
                  });
                  const response2 = await res.json(); */

                  if (status) {
                    message.channel.send('<@!' + message.author.id + '>: transferred ' + id + ' to 0x' + address2);
                  } else {
                    message.channel.send('<@!' + message.author.id + '>: could not transfer: ' + status);
                  }
                } else if (split[1] === 'treasury') {
                  let {mnemonic} = await _getUser();
                  if (!mnemonic) {
                    const spec = await _genKey();
                    mnemonic = spec.mnemonic;
                  }

                  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                  const address = wallet.getAddressString();
                  
                  const wallet2 = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(treasuryMnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                  const address2 = wallet2.getAddressString();

                  let status = true;
                  for (let i = 0; i < quantity; i++) {
                    try {
                      await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts['Trade']._address, true);
                      
                      const result = await runSidechainTransaction(mnemonic)('NFT', 'transferFrom', address, address2, id);
                      status = status && result.status;
                    } catch(err) {
                      console.warn(err.stack);
                      status = false;
                      break;
                    }
                  }

                  /* const contractSource = await blockchain.getContractSource('transferNft.cdc');
                  const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
                    method: 'POST',
                    body: JSON.stringify({
                      address: addr,
                      mnemonic,

                      limit: 100,
                      transaction: contractSource
                        .replace(/ARG0/g, id)
                        .replace(/ARG1/g, '0x' + addr2)
                        .replace(/ARG2/g, quantity),
                      wait: true,
                    }),
                  });
                  const response2 = await res.json(); */

                  if (status) {
                    message.channel.send('<@!' + message.author.id + '>: transferred ' + id + ' to treasury');
                  } else {
                    message.channel.send('<@!' + message.author.id + '>: could not transfer');
                  }
                } else {
                  message.channel.send('unknown user');
                }
              } else {
                message.channel.send('<@!' + message.author.id + '>: invalid quantity: ' + split[3]);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid token id: ' + split[2]);
            }
          } else if (split[0] === prefix + 'inventory') {
            let address, userLabel;
            const _loadFromUserId = async userId => {
              const spec = await _getUser(userId);
              let mnemonic = spec.mnemonic;
              if (!mnemonic) {
                const spec = await _genKey(userId);
                mnemonic = spec.mnemonic;
              }

              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              address = wallet.getAddressString();

              userLabel = '<@!' + userId + '>';
            };
            const _loadFromAddress = a => {
              address = a;
              userLabel = a;
            };
            const _loadFromTreasury = () => {
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(treasuryMnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              address = wallet.getAddressString();
              userLabel = 'treasury';
            };
            if (split.length >= 2 && (match = split[1].match(/<@!([0-9]+)>/))) {
              await _loadFromUserId(match[1]);
            } else if (split.length >= 2 && (match = split[1].match(/^(0x[0-9a-f]+)$/i))) {
              _loadFromAddress(match[1]);
            } else if (split.length >= 2 && split[1] === 'treasury') {
              _loadFromTreasury();
            } else {
              await _loadFromUserId(message.author.id);
            }

            const nftBalance = await contracts.NFT.methods.balanceOf(address).call();
            const hashToIds = {};
            for (let i = 0; i < nftBalance; i++) {
              const id = await contracts.NFT.methods.tokenOfOwnerByIndex(address, i).call();
              const hashNumberString = await contracts.NFT.methods.getHash(id).call();
              const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
              if (!hashToIds[hash]) {
                hashToIds[hash] = [];
              }
              hashToIds[hash].push(id);
            }
            const entries = [];
            for (const hash in hashToIds) {
              const ids = hashToIds[hash].sort();
              const id = ids[0];
              const filename = await contracts.NFT.methods.getMetadata(hash, 'filename').call();
              const balance = ids.length;
              const totalSupply = await contracts.NFT.methods.totalSupplyOfHash(hash).call();
              entries.push({
                id,
                ids,
                hash: hash.slice(2),
                filename,
                balance,
                totalSupply,
              });
            }

            /* const contractSource = await blockchain.getContractSource('getHashes.cdc');

            const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
              method: 'POST',
              body: JSON.stringify({
                limit: 100,
                script: contractSource
                  .replace(/ARG0/g, '0x' + addr),
                wait: true,
              }),
            });
            const response2 = await res.json();

            const entries = response2.encodedData.value.map(({value: {fields}}) => {
              const id = parseInt(fields.find(field => field.name === 'id').value.value, 10);
              const hash = fields.find(field => field.name === 'hash').value.value;
              const filename = fields.find(field => field.name === 'filename').value.value;
              const balance = parseInt(fields.find(field => field.name === 'balance').value.value, 10);
              const totalSupply = parseInt(fields.find(field => field.name === 'totalSupply').value.value, 10);
              return {id, hash, filename, balance, totalSupply};
            }); */

            let s = userLabel + '\'s inventory:\n';
            if (entries.length > 0) {
              s += '```' + entries.map((entry, i) => `${entry.id}. ${entry.filename} ${entry.hash} (${entry.balance}/${entry.totalSupply})${entry.ids.length > 1 ? ` [${entry.ids.join(',')}]` : ''}`).join('\n') + '```';
            } else {
              s += '```inventory empty```';
            }
            const m = await message.channel.send(s);
            m.react('❌');
            m.requester = message.author;
            helps.push(m);
          } else if (split[0] === prefix + 'wget' && split.length >= 2 && !isNaN(parseInt(split[1], 10))) {
            const id = parseInt(split[1], 10);
            
            if (!isNaN(id)) {
              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }
              
              const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
              const address = wallet.getAddressString();
              let owner = await contracts.NFT.methods.ownerOf(id).call();
              owner = owner.toLowerCase();
              if (owner === address) {
                const hashNumberString = await contracts.NFT.methods.getHash(id).call();
                const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
                const filename = await contracts.NFT.methods.getMetadata(hash, 'filename').call();

                const buffer = await _readStorageHashAsBuffer(hash.slice(2));
                const attachment = new Discord.MessageAttachment(buffer, filename);
                
                const m = await message.author.send('<@!' + message.author.id + '>: ' + id + ' is this', attachment);
                // m.react('❌');
              } else {
                message.channel.send('<@!' + message.author.id + '>: not your nft: ' + id);
              }
            } else {
              message.channel.send('<@!' + message.author.id + '>: invalid token id: ' + id);
            }
          } else if (split[0] === prefix + 'preview' && split.length >= 2 && !isNaN(parseInt(split[1], 10))) {
            const id = parseInt(split[1], 10);

            const hashNumberString = await contracts.NFT.methods.getHash(id).call();
            const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
            const filename = await contracts.NFT.methods.getMetadata(hash, 'filename').call();
            const match = filename.match(/^(.+)\.([^\.]+)$/);

            /* const contractSource = await blockchain.getContractSource('getNft.cdc');

            const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
              method: 'POST',
              body: JSON.stringify({
                limit: 100,
                script: contractSource
                  .replace(/ARG0/g, n),
                wait: true,
              }),
            });
            const response2 = await res.json();
            const [hash, filename] = response2.encodedData.value.map(value => value.value && value.value.value);
            const match = filename.match(/^(.+)\.([^\.]+)$/); */

            if (match) {
              const basename = match[1];
              const ext = match[2];
              const m = await message.channel.send('<@!' + message.author.id + '>: ' + id + ': https://preview.exokit.org/' + hash.slice(2) + '.' + ext + '/' + basename + '.png');
              m.react('❌');
              m.requester = message.author;
              helps.push(m);
            } else {
              message.channel.send('<@!' + message.author.id + '>: ' + id + ': no preview available');
            }
          } else if (split[0] === prefix + 'gif' && split.length >= 2 && !isNaN(parseInt(split[1], 10))) {
            const id = parseInt(split[1], 10);
            
            const hashNumberString = await contracts.NFT.methods.getHash(id).call();
            const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
            const filename = await contracts.NFT.methods.getMetadata(hash, 'filename').call();
            const match = filename.match(/^(.+)\.([^\.]+)$/);

            /* const contractSource = await blockchain.getContractSource('getNft.cdc');

            const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
              method: 'POST',
              body: JSON.stringify({
                limit: 100,
                script: contractSource
                  .replace(/ARG0/g, n),
                wait: true,
              }),
            });
            const response2 = await res.json();
            const [hash, filename] = response2.encodedData.value.map(value => value.value && value.value.value);
            const match = filename.match(/^(.+)\.([^\.]+)$/); */

            if (match) {
              const basename = match[1];
              const ext = match[2];
              message.channel.send('<@!' + message.author.id + '>: ' + id + ': https://preview.exokit.org/' + hash.slice(2) + '.' + ext + '/' + basename + '.gif');
            } else {
              message.channel.send('<@!' + message.author.id + '>: ' + id + ': no preview available');
            }
          } else if (split[0] === prefix + 'key') {
            let {mnemonic} = await _getUser();
            if (!mnemonic) {
              const spec = await _genKey();
              mnemonic = spec.mnemonic;
            }

            const m = await message.author.send('Key: ||' + mnemonic + '||');
            m.react('❌');
          } else if (split[0] === prefix + 'get' && split.length >= 3 && !isNaN(parseInt(split[1], 10))) {
            const id = parseInt(split[1], 10);
            const key = split[2];
            
            const hashNumberString = await contracts.NFT.methods.getHash(id).call();
            const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);
            const value = await contracts.NFT.methods.getMetadata(hash, key).call();

            /* const contractSource = await blockchain.getContractSource('getNftMetadata.cdc');

            const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
              method: 'POST',
              body: JSON.stringify({
                limit: 100,
                script: contractSource
                  .replace(/ARG0/g, id)
                  .replace(/ARG1/g, key),
                wait: true,
              }),
            });
            const response2 = await res.json();
            const value = response2.encodedData.value && response2.encodedData.value.value; */

            message.channel.send('<@!' + message.author.id + '>: ```' + id + '/' + key + ': ' + value + '```');
          } else if (split[0] === prefix + 'set' && split.length >= 4 && !isNaN(parseInt(split[1], 10))) {
            const id = parseInt(split[1], 10);
            const key = split[2];
            const value = split[3];

            let {mnemonic} = await _getUser();
            if (!mnemonic) {
              const spec = await _genKey();
              mnemonic = spec.mnemonic;
            }
            
            const hashNumberString = await contracts.NFT.methods.getHash(id).call();
            const hash = '0x' + web3.utils.padLeft(new web3.utils.BN(hashNumberString, 10).toString(16), 32);

            let status, transactionHash;
            try {
              const result = await runSidechainTransaction(mnemonic)('NFT', 'setMetadata', hash, key, value);
              status = result.status;
              transactionHash = result.transactionHash;
            } catch(err) {
              console.warn(err.stack);
              status = false;
              transactionHash = '0x0';
            }

            /* const contractSource = await blockchain.getContractSource('setNftMetadata.cdc');

            const res = await fetch(`https://accounts.exokit.org/sendTransaction`, {
              method: 'POST',
              body: JSON.stringify({
                address: addr,
                mnemonic,

                limit: 100,
                transaction: contractSource
                  .replace(/ARG0/g, id)
                  .replace(/ARG1/g, key)
                  .replace(/ARG2/g, value),
                wait: true,
              }),
            });
            const response2 = await res.json(); */

            if (status) {
              message.channel.send('<@!' + message.author.id + '>: ```' + id + '/' + key + ' = ' + value + '```');
            } else {
              message.channel.send('<@!' + message.author.id + '>: could not set: ' + transactionHash);
            }
          /* } else if (split[0] === prefix + 'createworld') {
            const res = await fetch('https://worlds.exokit.org/create', {
              method: 'POST',
            });
            if (res.ok) {
              const j = await res.json();
              const {id, url} = j;
              message.channel.send('<@!' + message.author.id + '>: created world: ```' + JSON.stringify(j, null, 2) + '```');
            } else {
              message.channel.send('<@!' + message.author.id + '>: failed to create world: ' + res.statusCode);
            }
          } else if (split[0] === prefix + 'destroyworld' && split.length >= 2 && split[1]) {
            const id = split[1];
            const res = await fetch('https://worlds.exokit.org/' + id, {
              method: 'DELETE',
            });
            if (res.ok) {
              await res.arrayBuffer();
              message.channel.send('<@!' + message.author.id + '>: destroyed world: ```' + id + '```');
            } else {
              message.channel.send('<@!' + message.author.id + '>: failed to destroy world: ' + res.statusCode);
            } */
          } else {
            if (split[0] === prefix + 'mint') {
              let quantity = parseInt(split[1], 10);
              let manualUrl;
              if (isNaN(quantity)) {
                quantity = 1;

                if (split[1] && /^https?:\/\//.test(split[1])) {
                  manualUrl = split[1];
                }
              } else {
                manualUrl = split[2];
              }

              let {mnemonic} = await _getUser();
              if (!mnemonic) {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }

              const files = [];
              if (manualUrl) {
                const match = manualUrl.match(/^http(s)?:\/\//);
                if (match) {
                  const proxyRes = await new Promise((accept, reject) => {
                    const proxyReq = (match[1] ? https : http).request(manualUrl, proxyRes => {
                      proxyRes.name = manualUrl.match(/\/([^\/]+?)(?:\?.*)?$/)[1];
                      if (!/\/..+$/.test(proxyRes.name)) {
                        const contentType = proxyRes.headers['content-type'];
                        if (contentType) {
                          const ext = mime.getExtension(contentType) || 'bin';
                          proxyRes.name += '.' + ext;
                        }
                      }
                      accept(proxyRes);
                    });
                    proxyReq.once('error', reject);
                    proxyReq.end();
                  });
                  files.push(proxyRes);
                }
              } else if (message.attachments.size > 0) {
                for (const [key, attachment] of message.attachments) {
                  const {name, url} = attachment;
                  
                  const proxyRes = await new Promise((accept, reject) => {
                    const proxyReq = https.request(url, proxyRes => {
                      proxyRes.name = name;
                      accept(proxyRes);
                    });
                    proxyReq.once('error', reject);
                    proxyReq.end();
                  });
                  files.push(proxyRes);
                }
              }
              if (files.length > 0) {
                await Promise.all(files.map(async file => {
                  const req = https.request(storageHost, {
                    method: 'POST',
                  }, res => {
                    const bs = [];
                    res.on('data', d => {
                      bs.push(d);
                    });
                    res.on('end', async () => {
                      const b = Buffer.concat(bs);
                      const s = b.toString('utf8');
                      const j = JSON.parse(s);
                      const {hash} = j;

                      const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
                      const address = wallet.getAddressString();

                      const fullAmount = {
                        t: 'uint256',
                        v: new web3.utils.BN(1e9)
                          .mul(new web3.utils.BN(1e9))
                          .mul(new web3.utils.BN(1e9)),
                      };

                      let status, transactionHash, tokenIds;
                      try {
                        {
                          const result = await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['NFT']._address, fullAmount.v);
                          status = result.status;
                          transactionHash = '0x0';
                          tokenIds = [];
                        }
                        if (status) {
                          const description = '';
                          console.log('minting', ['NFT', 'mint', address, '0x' + hash, file.name, description, quantity]);
                          const result = await runSidechainTransaction(mnemonic)('NFT', 'mint', address, '0x' + hash, file.name, description, quantity);
                          status = result.status;
                          transactionHash = result.transactionHash;
                          const tokenId = new web3.utils.BN(result.logs[0].topics[3].slice(2), 16).toNumber();
                          tokenIds = [tokenId, tokenId + quantity - 1];
                        }
                      } catch(err) {
                        console.warn(err.stack);
                        status = false;
                        transactionHash = '0x0';
                        tokenIds = [];
                      }
                      
                      console.log('minted 1', status);

                      if (status) {
                        message.channel.send('<@!' + message.author.id + '>: minted ' + (tokenIds[0] === tokenIds[1] ? ('#' + tokenIds[0]) : tokenIds.map(n => '#' + n).join(' - ')) + ' (' + hash + ')');
                      } else {
                        message.channel.send('<@!' + message.author.id + '>: mint transaction failed: ' + transactionHash);
                      }
                      
                      console.log('minted 2', status);
                    });
                    res.on('error', err => {
                      console.warn(err.stack);
                      message.channel.send('<@!' + message.author.id + '>: mint failed: ' + err.message);
                    });
                  });
                  req.on('error', err => {
                    console.warn(err.stack);
                    message.channel.send('<@!' + message.author.id + '>: mint failed: ' + err.message);
                  });
                  file.pipe(req);
                }));
              } else {
                message.channel.send('<@!' + message.author.id + '>: no files to mint');
              }
            }
          }
        } else if (message.channel.type === 'dm') {
          let {mnemonic} = await _getUser();

          const split = message.content.split(/\s+/);
          if (split[0] === prefix + 'key') {
            if (split.length === 12) {
              const mnemonic = split.join(' ');
              if (bip39.validateMnemonic(mnemonic)) {
                await ddb.putItem({
                  TableName: usersTableName,
                  Item: {
                    email: {S: id + '.discord'},
                    mnemonic: {S: mnemonic},
                  }
                }).promise();
                message.author.send('set key to ```' + JSON.stringify({
                  mnemonic,
                }) + '```');
              } else {
                message.author.send('invalid key');
              }
            } else {
              if (!mnemonic || split[1] === 'reset') {
                const spec = await _genKey();
                mnemonic = spec.mnemonic;
              }

              message.author.send('Key: ```' + mnemonic + '```');
            }
          }
        }
      }
    });
  });

  client.login(discordApiToken);
})();