CREATE TYPE task_series_recurrence AS ENUM ('none', 'weekly', 'monthly');
CREATE TYPE task_series_type AS ENUM ('temporary', 'operational');
CREATE TYPE task_series_status AS ENUM ('active', 'paused', 'stopped');

CREATE TABLE task_series (
  id serial PRIMARY KEY,
  title text NOT NULL,
  recurrence_type task_series_recurrence NOT NULL DEFAULT 'none',
  series_type task_series_type NOT NULL DEFAULT 'temporary',
  start_date timestamp NOT NULL,
  end_date timestamp,
  generate_until timestamp,
  status task_series_status NOT NULL DEFAULT 'active',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

ALTER TABLE tasks
  ADD COLUMN series_id integer REFERENCES task_series(id) ON DELETE SET NULL;

CREATE INDEX idx_tasks_series_id ON tasks(series_id);

CREATE UNIQUE INDEX uq_tasks_series_due_date
  ON tasks(series_id, due_date);
