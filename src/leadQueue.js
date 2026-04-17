const { db, rowToQueueItem } = require('./db');

function enqueuePending(item) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO queue_items (
         status, created_at, updated_at, channel, sender_id, customer_name,
         question, proposed_answer, confidence, reasons_json, review_note, listing_id,
         buyer_intent_score, buyer_intent_label, buyer_intent_signals
       ) VALUES (
         @status, @created_at, @updated_at, @channel, @sender_id, @customer_name,
         @question, @proposed_answer, @confidence, @reasons_json, @review_note, @listing_id,
         @buyer_intent_score, @buyer_intent_label, @buyer_intent_signals
       )`
    )
    .run({
      status: 'pending',
      created_at: now,
      updated_at: null,
      channel: item.channel || null,
      sender_id: item.senderId || null,
      customer_name: item.customerName || null,
      question: item.question || null,
      proposed_answer: item.proposedAnswer || null,
      confidence: Number.isFinite(item.confidence) ? item.confidence : null,
      reasons_json: JSON.stringify(Array.isArray(item.reasons) ? item.reasons : []),
      review_note: item.reviewNote || null,
      listing_id: item.listingId || null,
      buyer_intent_score: Number.isFinite(item.buyerIntentScore) ? item.buyerIntentScore : null,
      buyer_intent_label: item.buyerIntentLabel || null,
      buyer_intent_signals: JSON.stringify(Array.isArray(item.buyerIntentSignals) ? item.buyerIntentSignals : []),
    });

  return getById(String(result.lastInsertRowid));
}

function getPending() {
  return db
    .prepare('SELECT * FROM queue_items WHERE status = ? ORDER BY id DESC')
    .all('pending')
    .map(rowToQueueItem);
}

function getAll() {
  return db.prepare('SELECT * FROM queue_items ORDER BY id DESC').all().map(rowToQueueItem);
}

function getById(id) {
  const row = db.prepare('SELECT * FROM queue_items WHERE id = ?').get(Number(id));
  return rowToQueueItem(row);
}

function markApproved(id) {
  const result = db
    .prepare('UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ?')
    .run('approved', new Date().toISOString(), Number(id));
  if (result.changes === 0) return null;
  return getById(id);
}

function markRejected(id, reason) {
  const result = db
    .prepare('UPDATE queue_items SET status = ?, review_note = ?, updated_at = ? WHERE id = ?')
    .run('rejected', reason || null, new Date().toISOString(), Number(id));
  if (result.changes === 0) return null;
  return getById(id);
}

function markSent(id) {
  const result = db
    .prepare('UPDATE queue_items SET status = ?, updated_at = ? WHERE id = ?')
    .run('sent', new Date().toISOString(), Number(id));
  if (result.changes === 0) return null;
  return getById(id);
}

module.exports = {
  enqueuePending,
  getPending,
  getAll,
  getById,
  markApproved,
  markRejected,
  markSent,
};
