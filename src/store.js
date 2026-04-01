const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('./auth');

const users = new Map();
const accounts = new Map();

const stocks = [
  { symbol: 'DYN', company: 'Dynatrace Dynamics', price: 143.52, change: 0.4 },
  { symbol: 'CLD', company: 'Cloud Harbor Holdings', price: 89.11, change: -0.8 },
  { symbol: 'AIX', company: 'Apex Industrial X', price: 57.72, change: 1.1 },
  { symbol: 'GBK', company: 'Global Banking Labs', price: 102.03, change: 0.2 }
];

function createUser({ username, password, fullName }) {
  const id = uuidv4();
  const user = {
    id,
    username,
    fullName,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  const account = {
    userId: id,
    balance: 12500,
    transactions: [
      {
        id: uuidv4(),
        type: 'credit',
        amount: 12500,
        description: 'Initial simulated deposit',
        createdAt: new Date().toISOString()
      }
    ]
  };

  users.set(username, user);
  accounts.set(id, account);

  return sanitizeUser(user);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    createdAt: user.createdAt
  };
}

function getUserByUsername(username) {
  return users.get(username);
}

function getUserById(id) {
  for (const user of users.values()) {
    if (user.id === id) {
      return user;
    }
  }
  return null;
}

function getAccountByUserId(userId) {
  return accounts.get(userId);
}

function addTransaction(userId, transaction) {
  const account = accounts.get(userId);
  if (!account) {
    return null;
  }

  const nextTransaction = {
    id: uuidv4(),
    ...transaction,
    createdAt: new Date().toISOString()
  };

  if (transaction.type === 'debit') {
    account.balance -= transaction.amount;
  } else {
    account.balance += transaction.amount;
  }

  account.transactions.unshift(nextTransaction);
  return nextTransaction;
}

function getStocks() {
  return stocks.map((stock) => {
    const drift = (Math.random() - 0.5) * 2.4;
    const price = Number(Math.max(stock.price + drift, 10).toFixed(2));
    const change = Number((drift / stock.price * 100).toFixed(2));

    stock.price = price;
    stock.change = change;

    return { ...stock };
  });
}

createUser({
  username: 'demo',
  password: 'demo123',
  fullName: 'Demo User'
});

module.exports = {
  createUser,
  getUserByUsername,
  getUserById,
  getAccountByUserId,
  addTransaction,
  getStocks,
  sanitizeUser
};