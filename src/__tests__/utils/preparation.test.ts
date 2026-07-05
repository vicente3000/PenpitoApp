import { getSkippedSteps, getPreparationProgress, getOrderStatusLabel, recipeNeedsAgitation, recipeNeedsCarbonation } from '../../utils/preparation';
import { PreparationStepId } from '../../models';

describe('Preparation Utility (preparation.ts)', () => {
  describe('recipeNeedsAgitation', () => {
    it('should return true for negroni', () => {
      expect(recipeNeedsAgitation('negroni')).toBe(true);
    });

    it('should return false for recipes without agitation', () => {
      expect(recipeNeedsAgitation('piscola')).toBe(false);
      expect(recipeNeedsAgitation('whisky_rocks')).toBe(false);
      expect(recipeNeedsAgitation('campari_rocks')).toBe(false);
    });
  });

  describe('recipeNeedsCarbonation', () => {
    it('should return true for piscola', () => {
      expect(recipeNeedsCarbonation('piscola')).toBe(true);
    });

    it('should return false for other recipes', () => {
      expect(recipeNeedsCarbonation('negroni')).toBe(false);
      expect(recipeNeedsCarbonation('godfather')).toBe(false);
    });
  });

  describe('getSkippedSteps', () => {
    it('should skip carbonated_station for negroni when iceCount > 0', () => {
      const skipped = getSkippedSteps('negroni', 3);
      expect(skipped).toContain('carbonated_station');
      expect(skipped).not.toContain('agitation_system');
      expect(skipped).not.toContain('ice_dispenser');
    });

    it('should skip ice_dispenser and carbonated_station for negroni when iceCount is 0', () => {
      const skipped = getSkippedSteps('negroni', 0);
      expect(skipped).toContain('ice_dispenser');
      expect(skipped).toContain('carbonated_station');
      expect(skipped).not.toContain('agitation_system');
    });

    it('should skip agitation_system for piscola when iceCount > 0', () => {
      const skipped = getSkippedSteps('piscola', 2);
      expect(skipped).toContain('agitation_system');
      expect(skipped).not.toContain('carbonated_station');
      expect(skipped).not.toContain('ice_dispenser');
    });

    it('should skip ice_dispenser and agitation_system for piscola when iceCount is 0', () => {
      const skipped = getSkippedSteps('piscola', 0);
      expect(skipped).toContain('ice_dispenser');
      expect(skipped).toContain('agitation_system');
      expect(skipped).not.toContain('carbonated_station');
    });

    it('should skip only carbonated_station for godfather with iceCount > 0', () => {
      const skipped = getSkippedSteps('godfather', 3);
      expect(skipped).toContain('carbonated_station');
      expect(skipped).not.toContain('agitation_system');
      expect(skipped).not.toContain('ice_dispenser');
    });
  });

  describe('getPreparationProgress', () => {
    const totalSteps = 6; // cup_dispenser, ice_dispenser, alcohol_dispenser, agitation_system, carbonated_station, ready

    it('should return 1 if isReady is true', () => {
      expect(getPreparationProgress([], undefined, true)).toBe(1);
      expect(getPreparationProgress(['cup_dispenser'], 'ice_dispenser', true)).toBe(1);
    });

    it('should return 0 when completedStepIds is empty and there is no activeStepId', () => {
      expect(getPreparationProgress([])).toBe(0);
    });

    it('should return correct progress when only completedStepIds are provided', () => {
      const completed: PreparationStepId[] = ['cup_dispenser', 'ice_dispenser'];
      const expected = completed.length / totalSteps;
      expect(getPreparationProgress(completed)).toBe(expected);
    });

    it('should add activeStepBonus (0.55) to the progress calculation when activeStepId is provided', () => {
      const completed: PreparationStepId[] = ['cup_dispenser'];
      const expected = (completed.length + 0.55) / totalSteps;
      expect(getPreparationProgress(completed, 'ice_dispenser')).toBeCloseTo(expected, 5);
    });

    it('should cap progress at 1 if calculated value exceeds 1', () => {
      const completed: PreparationStepId[] = [
        'cup_dispenser',
        'ice_dispenser',
        'alcohol_dispenser',
        'agitation_system',
        'carbonated_station',
        'ready',
      ]; // 6 steps
      expect(getPreparationProgress(completed, 'ready')).toBe(1);
    });
  });

  describe('getOrderStatusLabel', () => {
    it('should return correct localized text for known statuses', () => {
      expect(getOrderStatusLabel('preparing')).toBe('En preparacion');
      expect(getOrderStatusLabel('ready')).toBe('Listo para servir');
      expect(getOrderStatusLabel('served')).toBe('Servido');
      expect(getOrderStatusLabel('failed')).toBe('No completado');
    });

    it('should fallback to status string for unknown status', () => {
      // @ts-ignore
      expect(getOrderStatusLabel('unknown_status')).toBe('unknown_status');
    });
  });
});
