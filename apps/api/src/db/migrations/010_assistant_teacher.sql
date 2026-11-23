-- The live brain (Gemini) as a teacher: its reading of each assistant message is kept beside BuildWise's own, so the
-- small local model can retrain on it. teacher_changes holds only the brief fields where the brain read the message
-- differently from the local rules (they become phrase-learning signals).
alter table assistant_messages add column teacher_intent text;
alter table assistant_messages add column teacher_changes jsonb;
alter table assistant_messages add column teacher_model text;
create index assistant_messages_teacher on assistant_messages (created_at) where teacher_intent is not null;
