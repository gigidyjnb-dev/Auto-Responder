const MAX_HISTORY = 8;
const { db } = require('./db');

function getHistory(senderId) {
  const rows = db
    .prepare(
      `SELECT question, answer, at
       FROM conversation_turns
       WHERE sender_id = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(senderId, MAX_HISTORY)
    .reverse();

  return rows.map((row) => ({
    question: row.question,
    answer: row.answer,
    at: row.at,
  }));
}

function addTurn(senderId, question, answer) {
  db.prepare('INSERT INTO conversation_turns (sender_id, question, answer, at) VALUES (?, ?, ?, ?)').run(
    senderId,
    question,
    answer,
    new Date().toISOString()
  );

  // Prune old rows per sender to cap growth.
  db.prepare(
    `DELETE FROM conversation_turns
     WHERE sender_id = ?
       AND id NOT IN (
         SELECT id FROM conversation_turns WHERE sender_id = ? ORDER BY id DESC LIMIT ?
       )`
  ).run(senderId, senderId, MAX_HISTORY);

  return getHistory(senderId);
}

module.exports = {
  getHistory,
  addTurn,
};
