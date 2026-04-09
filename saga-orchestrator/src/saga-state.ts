import { SagaStep, type SagaState } from '../../shared/saga-types.js';

export class SagaStore {
  private sagas = new Map<string, SagaState>();

  create(sagaId: string, input: { title: string; userId: number }): SagaState {
    const now = new Date().toISOString();
    const state: SagaState = {
      sagaId,
      step: SagaStep.CREATING_TODO,
      input,
      createdAt: now,
      updatedAt: now,
    };
    this.sagas.set(sagaId, state);
    console.log(`[ORCHESTRATOR] Saga ${sagaId} created → ${state.step}`);
    return state;
  }

  get(sagaId: string): SagaState | undefined {
    return this.sagas.get(sagaId);
  }

  update(sagaId: string, updates: Partial<SagaState>): SagaState {
    const current = this.sagas.get(sagaId);
    if (!current) throw new Error(`Saga ${sagaId} not found`);
    const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
    this.sagas.set(sagaId, updated);
    if (updates.step) {
      console.log(`[ORCHESTRATOR] Saga ${sagaId} → ${updates.step}`);
    }
    return updated;
  }

  list(): SagaState[] {
    return Array.from(this.sagas.values());
  }
}
