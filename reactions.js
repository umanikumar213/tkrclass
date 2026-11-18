const { ensureReactorIdentity } = require('./security');

// Names/columns come only from server-owned configuration, never from the request.
function reactionHandler({ pool, posts, reactions, emojis }) {
  return async (req, res) => {
    const id = Number(req.params.id);
    const emoji = req.body?.emoji ?? null;
    if (!Number.isSafeInteger(id) || id <= 0 || (emoji !== null && !emojis.has(emoji))) {
      return res.status(400).json({ success: false });
    }
    const hash = ensureReactorIdentity(req, res);
    if (!hash) return res.status(503).json({ success: false, message: 'Reactions are not configured.' });
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Lock the parent even when no visitor reaction row exists yet.
      const post = await client.query(`SELECT id FROM ${posts} WHERE id=$1 AND status='approved' FOR UPDATE`, [id]);
      if (!post.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false });
      }
      const prior = await client.query(`SELECT emoji FROM ${reactions} WHERE post_id=$1 AND reactor_hash=$2`, [id, hash]);
      const previous = prior.rows[0]?.emoji ?? null;
      if (previous !== emoji) {
        if (emoji === null) {
          await client.query(`DELETE FROM ${reactions} WHERE post_id=$1 AND reactor_hash=$2`, [id, hash]);
        } else {
          await client.query(`INSERT INTO ${reactions}(post_id,reactor_hash,emoji) VALUES($1,$2,$3)
            ON CONFLICT(post_id,reactor_hash) DO UPDATE SET emoji=EXCLUDED.emoji,updated_at=NOW()`, [id, hash, emoji]);
        }
        const sets = [];
        if (emojis.has(previous)) sets.push(`react_${previous}=GREATEST(0,react_${previous}-1)`);
        if (emoji !== null) sets.push(`react_${emoji}=react_${emoji}+1`);
        if (sets.length) await client.query(`UPDATE ${posts} SET ${sets.join(',')} WHERE id=$1`, [id]);
      }
      const counts = await client.query(`SELECT ${[...emojis].map(e => `react_${e}`).join(',')} FROM ${posts} WHERE id=$1`, [id]);
      await client.query('COMMIT');
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, emoji, counts: counts.rows[0] });
    } catch {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Reaction transaction failed.');
      res.status(500).json({ success: false, message: 'Could not save reaction.' });
    } finally { client?.release(); }
  };
}
module.exports = { reactionHandler };
