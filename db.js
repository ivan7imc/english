import 'dotenv/config';
import pg from 'pg';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

let pool = null;
let pglite = null;
let kind = 'neon';

export function databaseKind() {
  return kind;
}

export async function initDatabase() {
  const url = process.env.DATABASE_URL?.trim();
  const demo = process.env.DEMO_MODE === 'true';

  if (url && !demo) {
    kind = 'postgres';
    let ssl = false;
    try {
      const parsed = new URL(url);
      const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      const disabled = parsed.searchParams.get('sslmode') === 'disable';
      ssl = local || disabled || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: true };
    } catch {
      throw new Error('DATABASE_URL inválida. Copie a connection string do Neon em Connect.');
    }
    pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
      ssl,
      application_name: 'english-hub'
    });
    pool.on('error', (err) => console.error('[db] conexão ociosa caiu:', err.message));
  } else if (demo) {
    // PGlite é PostgreSQL em WASM, usado SOMENTE na demonstração local.
    // Produção no Render usa Neon via DATABASE_URL (driver pg acima).
    kind = 'demo';
    const { PGlite } = await import('@electric-sql/pglite');
    const dataDir = process.env.DEMO_DB_PATH || path.join(__dirname, 'data', 'demo-db');
    if (dataDir !== ':memory:') await mkdir(path.dirname(dataDir), { recursive: true });
    pglite = dataDir === ':memory:' ? new PGlite() : new PGlite(dataDir);
    await pglite.waitReady;
    console.log('[db] DEMO MODE: banco local PGlite. Não use este modo em produção.');
  } else {
    throw new Error('Defina DATABASE_URL com a connection string do Neon. Para demonstração local: npm run demo.');
  }

  const schema = await readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  if (pool) await pool.query(schema);
  else await pglite.exec(schema);

  await query('SELECT 1 AS ok');
  return kind;
}

export async function query(text, params = []) {
  if (pool) return pool.query(text, params);
  if (pglite) return pglite.query(text, params);
  throw new Error('Banco não inicializado.');
}

export async function withTransaction(fn) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  if (pglite) return pglite.transaction((tx) => fn(tx));
  throw new Error('Banco não inicializado.');
}

export async function closeDatabase() {
  if (pool) await pool.end();
  if (pglite) await pglite.close();
  pool = null;
  pglite = null;
}
