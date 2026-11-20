UPDATE approvals a
SET clarification_question=NULL,clarification_answer=NULL,clarification_requested_at=NULL,clarification_answered_at=NULL
WHERE a.state='pending' AND a.clarification_answered_at IS NOT NULL
 AND EXISTS(SELECT 1 FROM decisions d WHERE d.approval_id=a.id AND d.decision='clarify'
  AND d.created_at=a.clarification_requested_at AND d.step_index<a.current_step
  AND NOT EXISTS(SELECT 1 FROM decision_retractions r WHERE r.decision_id=d.id));

UPDATE approvals SET action_revision=action_revision+1
WHERE state='pending' AND canceled_at IS NULL AND clarification_answered_at IS NOT NULL;
