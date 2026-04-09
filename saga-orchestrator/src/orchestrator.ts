import {
  SagaStep,
  ORCHESTRATION_EXCHANGE,
  ORK,
  type SagaState,
  type CreateTodoReply,
  type ValidateUserReply,
  type SendNotificationReply,
  type GenerateNoteCardReply,
} from '../../shared/saga-types.js';

// Pure state machine: given (currentState, reply) → (nextState, command to publish)
// Returns the updates to apply and optionally a command to publish next.

interface Transition {
  updates: Partial<SagaState>;
  publish?: { exchange: string; routingKey: string; payload: object };
}

export function handleCreateTodoReply(
  state: SagaState,
  reply: CreateTodoReply
): Transition {
  if (!reply.success) {
    return {
      updates: { step: SagaStep.FAILED, error: reply.error || 'Todo creation failed' },
    };
  }

  return {
    updates: {
      step: SagaStep.VALIDATING_USER,
      todoId: reply.todoId,
      todo: reply.todo,
    },
    publish: {
      exchange: ORCHESTRATION_EXCHANGE,
      routingKey: ORK.CMD_USER_VALIDATE,
      payload: {
        sagaId: state.sagaId,
        userId: state.input.userId,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

export function handleValidateUserReply(
  state: SagaState,
  reply: ValidateUserReply
): Transition {
  if (!reply.success) {
    // Compensate: delete the todo we created
    return {
      updates: {
        step: SagaStep.FAILED,
        error: reply.error || 'User validation failed',
      },
      publish: {
        exchange: ORCHESTRATION_EXCHANGE,
        routingKey: ORK.CMD_TODO_DELETE,
        payload: {
          sagaId: state.sagaId,
          todoId: state.todoId,
          timestamp: new Date().toISOString(),
        },
      },
    };
  }

  return {
    updates: { step: SagaStep.SENDING_NOTIFICATION, user: reply.user },
    publish: {
      exchange: ORCHESTRATION_EXCHANGE,
      routingKey: ORK.CMD_NOTIFICATION_SEND,
      payload: {
        sagaId: state.sagaId,
        todoId: state.todoId,
        userId: state.input.userId,
        message: `New TODO created: "${state.input.title}" (assigned to ${reply.user?.name})`,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

export function handleSendNotificationReply(
  state: SagaState,
  reply: SendNotificationReply
): Transition {
  if (!reply.success) {
    // Compensate: delete the todo
    return {
      updates: {
        step: SagaStep.FAILED,
        error: reply.error || 'Notification failed',
      },
      publish: {
        exchange: ORCHESTRATION_EXCHANGE,
        routingKey: ORK.CMD_TODO_DELETE,
        payload: {
          sagaId: state.sagaId,
          todoId: state.todoId,
          timestamp: new Date().toISOString(),
        },
      },
    };
  }

  return {
    updates: { step: SagaStep.GENERATING_NOTECARD },
    publish: {
      exchange: ORCHESTRATION_EXCHANGE,
      routingKey: ORK.CMD_NOTECARD_GENERATE,
      payload: {
        sagaId: state.sagaId,
        todoId: state.todoId,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

export function handleGenerateNoteCardReply(
  state: SagaState,
  reply: GenerateNoteCardReply
): Transition {
  if (!reply.success) {
    // Compensate: delete the todo
    return {
      updates: {
        step: SagaStep.FAILED,
        error: reply.error || 'Note card generation failed',
      },
      publish: {
        exchange: ORCHESTRATION_EXCHANGE,
        routingKey: ORK.CMD_TODO_DELETE,
        payload: {
          sagaId: state.sagaId,
          todoId: state.todoId,
          timestamp: new Date().toISOString(),
        },
      },
    };
  }

  return {
    updates: { step: SagaStep.COMPLETED },
  };
}

