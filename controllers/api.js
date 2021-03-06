import { User } from '../class/User';
const config = require('../config');
let express = require('express');
let router = express.Router();
let assert = require('assert');
console.log('using config', JSON.stringify(config));

var Redis = require('ioredis');
var redis = new Redis(config.redis);
redis.monitor(function(err, monitor) {
  monitor.on('monitor', function(time, args, source, database) {
    console.log('REDIS', JSON.stringify(args));
  });
});

let bitcoinclient = require('../bitcoin');
let lightning = require('../lightning');

// ###################### SMOKE TESTS ########################

bitcoinclient.request('getblockchaininfo', false, function(err, info) {
  if (info && info.result && info.result.blocks) {
    if (info.result.blocks < 550000) {
      console.error('bitcoind is not caught up');
      process.exit(1);
    }
  } else {
    console.error('bitcoind failure');
    process.exit(2);
  }
});

lightning.getInfo({}, function(err, info) {
  if (err) {
    console.error('lnd failure');
    process.exit(3);
  }
  if (info) {
    if (!info.synced_to_chain) {
      console.error('lnd not synced');
      process.exit(4);
    }
  }
});

redis.info(function(err, info) {
  if (err || !info) {
    console.error('redis failure');
    process.exit(5);
  }
});

// ######################## ROUTES ########################

router.post('/create', async function(req, res) {
  assert.ok(req.body.partnerid);
  assert.ok(req.body.partnerid === 'bluewallet');
  assert.ok(req.body.accounttype);

  let u = new User(redis);
  await u.create();
  res.send({ login: u.getLogin(), password: u.getPassword() });
});

router.post('/auth', async function(req, res) {
  assert.ok((req.body.login && req.body.password) || req.body.refresh_token);

  let u = new User(redis);

  if (req.body.refresh_token) {
    // need to refresh token
    if (await u.loadByRefreshToken(req.body.refresh_token)) {
      res.send({ refresh_token: u.getRefreshToken(), access_token: u.getAccessToken() });
    } else {
      return errorBadAuth(res);
    }
  } else {
    // need to authorize user
    let result = await u.loadByLoginAndPassword(req.body.login, req.body.password);
    if (result) res.send({ refresh_token: u.getRefreshToken(), access_token: u.getAccessToken() });
    else errorBadAuth(res);
  }
});

router.post('/payinvoice', async function(req, res) {
  let u = new User(redis);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }
  assert.ok(req.body.invoice);

  let userBalance = await u.getBalance();

  lightning.decodePayReq({ pay_req: req.body.invoice }, function(err, info) {
    if (err) return errorNotAValidInvoice(res);

    if (userBalance > info.num_satoshis) {
      // got enough balance
      var call = lightning.sendPayment();
      call.on('data', function(payment) {
        // payment callback
        if (payment && payment.payment_route && payment.payment_route.total_amt_msat) {
          userBalance -= +payment.payment_route.total_fees + +payment.payment_route.total_amt;
          u.saveBalance(userBalance);
          payment.pay_req = req.body.invoice;
          payment.decoded = info;
          u.savePaidLndInvoice(payment);
          res.send(payment);
        } else {
          // payment failed
          return errorLnd(res);
        }
      });
      let inv = { payment_request: req.body.invoice };
      call.write(inv);
    } else {
      return errorNotEnougBalance(res);
    }
  });
});

router.get('/getbtc', async function(req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  await u.loadByAuthorization(req.headers.authorization);

  if (!u.getUserId()) {
    return errorBadAuth(res);
  }

  let address = await u.getAddress();
  if (!address) {
    await u.generateAddress();
    address = await u.getAddress();
  }

  res.send([{ address }]);
});

router.get('/balance', async function(req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!(await u.getAddress())) await u.generateAddress(); // onchain address needed further
  await u.accountForPosibleTxids();
  let balance = await u.getBalance();
  res.send({ BTC: { AvailableBalance: balance } });
});

router.get('/getinfo', async function(req, res) {
  let u = new User(redis);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  lightning.getInfo({}, function(err, info) {
    if (err) return errorLnd(res);
    res.send(info);
  });
});

router.get('/gettxs', async function(req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!(await u.getAddress())) await u.generateAddress(); // onchain addr needed further
  await u.accountForPosibleTxids();
  let txs = await u.getTxs();
  res.send(txs);
});

router.get('/getpending', async function(req, res) {
  let u = new User(redis, bitcoinclient, lightning);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!(await u.getAddress())) await u.generateAddress(); // onchain address needed further
  await u.accountForPosibleTxids();
  let txs = await u.getPendingTxs();
  res.send(txs);
});

router.get('/decodeinvoice', async function(req, res) {
  let u = new User(redis, bitcoinclient);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!req.query.invoice) return errorGeneralServerError(res);

  lightning.decodePayReq({ pay_req: req.query.invoice }, function(err, info) {
    if (err) return errorNotAValidInvoice(res);
    res.send(info);
  });
});

router.get('/checkrouteinvoice', async function(req, res) {
  let u = new User(redis, bitcoinclient);
  if (!(await u.loadByAuthorization(req.headers.authorization))) {
    return errorBadAuth(res);
  }

  if (!req.query.invoice) return errorGeneralServerError(res);

  // at the momment does nothing.
  // TODO: decode and query actual route to destination
  lightning.decodePayReq({ pay_req: req.query.invoice }, function(err, info) {
    if (err) return errorNotAValidInvoice(res);
    res.send(info);
  });
});

module.exports = router;

// ################# HELPERS ###########################

function errorBadAuth(res) {
  return res.send({
    error: true,
    code: 1,
    message: 'bad auth',
  });
}

function errorNotEnougBalance(res) {
  return res.send({
    error: true,
    code: 2,
    message: 'not enough balance',
  });
}

function errorNotAValidInvoice(res) {
  return res.send({
    error: true,
    code: 4,
    message: 'not a valid invoice',
  });
}

function errorLnd(res) {
  return res.send({
    error: true,
    code: 7,
    message: 'LND failue',
  });
}

function errorGeneralServerError(res) {
  return res.send({
    error: true,
    code: 6,
    message: 'Server fault',
  });
}
