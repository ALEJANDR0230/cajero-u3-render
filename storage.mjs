import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const maxBalance = 100_000_000;
const missingFunds = 'Saldo insuficiente para este retiro.';
const excessFunds = 'El depósito supera el límite de la cuenta de práctica.';

function nextBalance(balance, type, amount) {
  const updated = balance + (type === 'deposit' ? amount : -amount);
  if (updated < 0) return { error: missingFunds };
  if (updated > maxBalance) return { error: excessFunds };
  return { balance: updated };
}

function sqliteStore() {
  const directory = resolve(process.env.DATA_DIR ?? './data');
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'cajero.sqlite'));
  db.exec(
    'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;' +
    'CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY CHECK(id = 1), balance INTEGER NOT NULL CHECK(balance >= 0));' +
    'INSERT OR IGNORE INTO account (id, balance) VALUES (1, 100000);' +
    "CREATE TABLE IF NOT EXISTS movement (id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('deposit', 'withdraw')), " +
    'amount INTEGER NOT NULL CHECK(amount > 0), balance INTEGER NOT NULL CHECK(balance >= 0), created_at TEXT NOT NULL);'
  );
  const getBalance = db.prepare('SELECT balance FROM account WHERE id = 1');
  const setBalance = db.prepare('UPDATE account SET balance = ? WHERE id = 1');
  const getMovements = db.prepare('SELECT * FROM movement ORDER BY id DESC LIMIT 30');
  const addMovement = db.prepare('INSERT INTO movement (type, amount, balance, created_at) VALUES (?, ?, ?, ?)');
  const account = () => ({ balance: getBalance.get().balance, movements: getMovements.all() });
  return {
    database: 'sqlite',
    account,
    check: () => getBalance.get(),
    record(type, amount) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = nextBalance(getBalance.get().balance, type, amount);
        if (result.error) {
          db.exec('ROLLBACK');
          return result;
        }
        const { balance } = result;
        setBalance.run(balance);
        const { lastInsertRowid } = addMovement.run(type, amount, balance, new Date().toISOString());
        const snapshot = account();
        db.exec('COMMIT');
        return { ...snapshot, receipt: { id: Number(lastInsertRowid), type, amount, balance } };
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

async function postgresStore(url) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 10000 });
  pool.on('error', () => console.error('Conexión con PostgreSQL interrumpida.'));
  await pool.query(
    'CREATE SCHEMA IF NOT EXISTS cajero_u3;' +
    'CREATE TABLE IF NOT EXISTS cajero_u3.account (id INTEGER PRIMARY KEY CHECK(id = 1), balance INTEGER NOT NULL CHECK(balance >= 0));' +
    'INSERT INTO cajero_u3.account (id, balance) VALUES (1, 100000) ON CONFLICT (id) DO NOTHING;' +
    "CREATE TABLE IF NOT EXISTS cajero_u3.movement (id SERIAL PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('deposit', 'withdraw')), " +
    'amount INTEGER NOT NULL CHECK(amount > 0), balance INTEGER NOT NULL CHECK(balance >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now());'
  );
  const selectBalance = 'SELECT balance FROM cajero_u3.account WHERE id = 1';
  const selectMovements = 'SELECT id, type, amount, balance, created_at FROM cajero_u3.movement ORDER BY id DESC LIMIT 30';
  return {
    database: 'postgresql',
    async check() { await pool.query(selectBalance); },
    async account() {
      const { rows: [state] } = await pool.query(
        'SELECT balance, (SELECT COALESCE(json_agg(m ORDER BY m.id DESC), \'[]\'::json) FROM (' +
        selectMovements + ') m) AS movements FROM cajero_u3.account WHERE id = 1'
      );
      return state;
    },
    async record(type, amount) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [current] } = await client.query(selectBalance + ' FOR UPDATE');
        const result = nextBalance(current.balance, type, amount);
        if (result.error) {
          await client.query('ROLLBACK');
          return result;
        }
        const { balance } = result;
        await client.query('UPDATE cajero_u3.account SET balance = $1 WHERE id = 1', [balance]);
        const { rows: [receipt] } = await client.query(
          'INSERT INTO cajero_u3.movement (type, amount, balance) VALUES ($1, $2, $3) RETURNING id, type, amount, balance',
          [type, amount, balance]
        );
        const { rows: movements } = await client.query(selectMovements);
        await client.query('COMMIT');
        return { balance, movements, receipt };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export const store = process.env.DATABASE_URL
  ? await postgresStore(process.env.DATABASE_URL)
  : sqliteStore();
