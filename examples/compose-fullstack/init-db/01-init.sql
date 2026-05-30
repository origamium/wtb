-- Seeds a row so a cloned worktree visibly starts with main's data.
CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text NOT NULL);
INSERT INTO notes (body) VALUES ('hello from the source worktree');
