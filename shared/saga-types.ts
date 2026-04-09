// ============================================================
// Saga Types — Single source of truth for all message contracts
// ============================================================

// --- Exchange & Queue Constants ---

export const ORCHESTRATION_EXCHANGE = 'saga.orchestration';
export const CHOREOGRAPHY_EXCHANGE = 'saga.choreography';

// Orchestration routing keys
export const ORK = {
  CMD_TODO_CREATE: 'cmd.todo.create',
  CMD_TODO_CREATE_REPLY: 'cmd.todo.create.reply',
  CMD_USER_VALIDATE: 'cmd.user.validate',
  CMD_USER_VALIDATE_REPLY: 'cmd.user.validate.reply',
  CMD_NOTIFICATION_SEND: 'cmd.notification.send',
  CMD_NOTIFICATION_SEND_REPLY: 'cmd.notification.send.reply',
  CMD_NOTECARD_GENERATE: 'cmd.notecard.generate',
  CMD_NOTECARD_GENERATE_REPLY: 'cmd.notecard.generate.reply',
  CMD_TODO_DELETE: 'cmd.todo.delete',
} as const;

// Choreography routing keys
export const CRK = {
  TODO_ASSIGNMENT_REQUESTED: 'todo.assignment.requested',
  USER_VALIDATED: 'user.validated',
  USER_VALIDATION_FAILED: 'user.validation.failed',
  TODO_ASSIGNMENT_CONFIRMED: 'todo.assignment.confirmed',
  TODO_ASSIGNMENT_ROLLEDBACK: 'todo.assignment.rolledback',
  NOTIFICATION_SENT: 'notification.sent',
} as const;

// --- Orchestration Saga State ---

export enum SagaStep {
  CREATING_TODO = 'CREATING_TODO',
  VALIDATING_USER = 'VALIDATING_USER',
  SENDING_NOTIFICATION = 'SENDING_NOTIFICATION',
  GENERATING_NOTECARD = 'GENERATING_NOTECARD',
  COMPLETED = 'COMPLETED',
  COMPENSATING = 'COMPENSATING',
  FAILED = 'FAILED',
}

export interface SagaState {
  sagaId: string;
  step: SagaStep;
  input: { title: string; userId: number };
  todoId?: number;
  todo?: { id: number; title: string; completed: boolean };
  user?: { id: number; name: string; email: string };
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// --- Orchestration Message Payloads ---

export interface SagaCommand {
  sagaId: string;
  timestamp: string;
}

export interface CreateTodoCmd extends SagaCommand {
  title: string;
  userId: number;
}

export interface CreateTodoReply extends SagaCommand {
  success: boolean;
  todoId?: number;
  todo?: { id: number; title: string; completed: boolean };
  error?: string;
}

export interface ValidateUserCmd extends SagaCommand {
  userId: number;
}

export interface ValidateUserReply extends SagaCommand {
  success: boolean;
  user?: { id: number; name: string; email: string };
  error?: string;
}

export interface SendNotificationCmd extends SagaCommand {
  todoId: number;
  userId: number;
  message: string;
}

export interface SendNotificationReply extends SagaCommand {
  success: boolean;
  error?: string;
}

export interface GenerateNoteCardCmd extends SagaCommand {
  todoId: number;
}

export interface GenerateNoteCardReply extends SagaCommand {
  success: boolean;
  error?: string;
}

export interface DeleteTodoCmd extends SagaCommand {
  todoId: number;
}

// --- Choreography Event Payloads ---

export interface ChoreographyEvent {
  correlationId: string;
  timestamp: string;
}

export interface TodoAssignmentRequested extends ChoreographyEvent {
  todoId: number;
  userId: number;
}

export interface UserValidated extends ChoreographyEvent {
  todoId: number;
  userId: number;
  user: { id: number; name: string; email: string };
}

export interface UserValidationFailed extends ChoreographyEvent {
  todoId: number;
  userId: number;
  reason: string;
}

export interface TodoAssignmentConfirmed extends ChoreographyEvent {
  todoId: number;
  userId: number;
  todoTitle: string;
  userEmail: string;
}

export interface TodoAssignmentRolledBack extends ChoreographyEvent {
  todoId: number;
  userId: number;
  reason: string;
}

export interface NotificationSent extends ChoreographyEvent {
  todoId: number;
  userId: number;
}
