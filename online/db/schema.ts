import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const records = sqliteTable('records', {
  owner: text('owner').notNull(), kind: text('kind').notNull(), id: text('id').notNull(),
  body: text('body').notNull(), revision: integer('revision').notNull().default(1),
  requestId: text('request_id'), updatedAt: integer('updated_at').notNull(),
}, t => [primaryKey({ columns: [t.owner,t.kind,t.id] }), uniqueIndex('records_request').on(t.owner,t.kind,t.requestId)]);
export const settings = sqliteTable('settings', {
  owner: text('owner').primaryKey(), ciphertext: text('ciphertext').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
