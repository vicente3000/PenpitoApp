import { ICommunicationAdapter } from './ICommunicationAdapter';
import { DeviceCommand, MachineState, PreparationStepId } from '../models';

export class MockAdapter implements ICommunicationAdapter {
  private isConnected = false;
  private stateChangeCallback: ((state: MachineState) => void) | null = null;
  private timeoutRef: ReturnType<typeof setTimeout> | null = null;
  private sequenceTimeouts: ReturnType<typeof setTimeout>[] = [];

  private currentState: MachineState = {
    isOn: false,
    status: 'idle',
    currentRecipeId: undefined,
    requestedIceCount: 2,
    activeStepId: undefined,
    completedStepIds: [],
    skippedStepIds: [],
    isDrinkReady: false,
  };

  async connect(): Promise<boolean> {
    console.log('[MockAdapter] Connecting...');
    return new Promise((resolve) =>
      setTimeout(() => {
        this.isConnected = true;
        console.log('[MockAdapter] Connected');
        this.fireStateChange();
        resolve(true);
      }, 1000)
    );
  }

  async disconnect(): Promise<void> {
    this.clearTimers();
    this.isConnected = false;
    this.currentState = {
      isOn: false,
      status: 'idle',
      currentRecipeId: undefined,
      requestedIceCount: 2,
      activeStepId: undefined,
      completedStepIds: [],
      skippedStepIds: [],
      isDrinkReady: false,
    };
    this.fireStateChange();
    console.log('[MockAdapter] Disconnected');
  }

  async sendCommand(command: DeviceCommand): Promise<boolean> {
    if (!this.isConnected) {
      console.warn('[MockAdapter] Cannot send command, not connected.');
      return false;
    }

    console.log(`[MockAdapter] Received Command: ${command.cmd}=${command.val}`);

    if (command.cmd === 'POWER') {
      this.currentState.isOn = command.val === 'ON';
      if (!this.currentState.isOn) {
        this.clearTimers();
        this.currentState.status = 'idle';
        this.currentState.currentRecipeId = undefined;
        this.currentState.requestedIceCount = 2;
        this.currentState.activeStepId = undefined;
        this.currentState.completedStepIds = [];
        this.currentState.skippedStepIds = [];
        this.currentState.isDrinkReady = false;
      }
      this.fireStateChange();
      return true;
    }

    if (command.cmd === 'PREPARE') {
      if (!this.currentState.isOn) {
        console.warn('[MockAdapter] Machine is off, cannot prepare.');
        return false;
      }

      this.startPreparationSequence(command.val, command.iceCount ?? 2);
      return true;
    }

    if (command.cmd === 'CLEAN') {
      if (!this.currentState.isOn) {
        return false;
      }

      this.clearTimers();
      this.currentState.status = 'cleaning';
      this.currentState.activeStepId = undefined;
      this.currentState.isDrinkReady = false;
      this.fireStateChange();

      this.timeoutRef = setTimeout(() => {
        this.currentState.status = 'idle';
        console.log('[MockAdapter] Cleaning finished!');
        this.fireStateChange();
      }, 3000);
      return true;
    }

    return true;
  }

  onStateChange(callback: (state: MachineState) => void): void {
    this.stateChangeCallback = callback;
    this.fireStateChange();
  }

  private fireStateChange() {
    if (this.stateChangeCallback) {
      this.stateChangeCallback({ ...this.currentState });
    }
  }

  private clearTimers() {
    if (this.timeoutRef) {
      clearTimeout(this.timeoutRef);
      this.timeoutRef = null;
    }

    this.sequenceTimeouts.forEach((timer) => clearTimeout(timer));
    this.sequenceTimeouts = [];
  }

  private recipeNeedsAgitation(recipeId: string) {
    return recipeId === 'negroni';
  }

  private recipeNeedsCarbonation(recipeId: string) {
    return recipeId === 'piscola' || recipeId === 'gin_tonic';
  }

  private startPreparationSequence(recipeId: string, iceCount: number) {
    this.clearTimers();

    const needsAgitation = this.recipeNeedsAgitation(recipeId);
    const needsCarbonation = this.recipeNeedsCarbonation(recipeId);
    const skippedSteps: PreparationStepId[] = [];

    if (iceCount === 0) {
      skippedSteps.push('ice_dispenser');
    }
    if (!needsAgitation) {
      skippedSteps.push('agitation_system');
    }
    if (!needsCarbonation) {
      skippedSteps.push('carbonated_station');
    }

    const sequence: PreparationStepId[] = ['cup_dispenser'];
    if (iceCount > 0) {
      sequence.push('ice_dispenser');
    }
    sequence.push('alcohol_dispenser');
    if (needsAgitation) {
      sequence.push('agitation_system');
    }
    if (needsCarbonation) {
      sequence.push('carbonated_station');
    }
    sequence.push('ready');

    this.currentState.status = 'preparing';
    this.currentState.currentRecipeId = recipeId;
    this.currentState.requestedIceCount = iceCount;
    this.currentState.activeStepId = sequence[0];
    this.currentState.completedStepIds = [];
    this.currentState.skippedStepIds = skippedSteps;
    this.currentState.isDrinkReady = false;
    this.fireStateChange();

    sequence.forEach((step, index) => {
      const timer = setTimeout(() => {
        if (step === 'ready') {
          this.currentState.activeStepId = 'ready';
          this.currentState.completedStepIds = sequence.filter((item) => item !== 'ready');
          this.currentState.isDrinkReady = true;
          console.log('[MockAdapter] Drink is ready!');
          this.fireStateChange();

          this.timeoutRef = setTimeout(() => {
            this.currentState.status = 'idle';
            this.currentState.currentRecipeId = undefined;
            this.currentState.requestedIceCount = 2;
            this.currentState.activeStepId = undefined;
            this.currentState.completedStepIds = [];
            this.currentState.skippedStepIds = [];
            this.currentState.isDrinkReady = false;
            this.fireStateChange();
          }, 2200);
          return;
        }

        this.currentState.activeStepId = step;
        this.currentState.completedStepIds = sequence.slice(0, index);
        this.currentState.isDrinkReady = false;
        this.fireStateChange();
      }, index * 1400);

      this.sequenceTimeouts.push(timer);
    });
  }
}
