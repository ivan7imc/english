import { initDatabase, closeDatabase, databaseKind } from '../db.js';

try {
  const kind = await initDatabase();
  console.log(`Esquema criado/verificado com sucesso (${kind}).`);
} catch (err) {
  console.error('Falha ao inicializar o banco:', err.message);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
