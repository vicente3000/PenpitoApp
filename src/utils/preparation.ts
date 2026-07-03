import FontAwesome from '@expo/vector-icons/FontAwesome';
import { DrinkOrderStatus, PreparationStepId } from '../models';

export type PreparationStepDefinition = {
  id: PreparationStepId;
  title: string;
  description: string;
  icon: React.ComponentProps<typeof FontAwesome>['name'];
};

export const preparationSteps: PreparationStepDefinition[] = [
  {
    id: 'cup_dispenser',
    title: 'Sirviendo vaso',
    description: 'Colocando el vaso en la estación.',
    icon: 'glass',
  },
  {
    id: 'ice_dispenser',
    title: 'Sirviendo hielo',
    description: 'Agregando hielo.',
    icon: 'cube',
  },
  {
    id: 'alcohol_dispenser',
    title: 'Sirviendo alcohol',
    description: 'Dosificando licores y destilados.',
    icon: 'tint',
  },
  {
    id: 'agitation_system',
    title: 'Mezclando',
    description: 'Revolviendo el cóctel.',
    icon: 'refresh',
  },
  {
    id: 'carbonated_station',
    title: 'Sirviendo bebida',
    description: 'Completando con bebida carbonatada.',
    icon: 'bolt',
  },
  {
    id: 'ready',
    title: 'Listo',
    description: 'Cóctel listo para retirar.',
    icon: 'check-circle',
  },
];

export function recipeNeedsAgitation(recipeId: string) {
  return recipeId === 'negroni';
}

export function recipeNeedsCarbonation(recipeId: string) {
  return recipeId === 'piscola' || recipeId === 'gin_tonic';
}

export function getSkippedSteps(recipeId: string, iceCount: number) {
  const skippedSteps: PreparationStepId[] = [];

  if (iceCount === 0) {
    skippedSteps.push('ice_dispenser');
  }

  if (!recipeNeedsAgitation(recipeId)) {
    skippedSteps.push('agitation_system');
  }

  if (!recipeNeedsCarbonation(recipeId)) {
    skippedSteps.push('carbonated_station');
  }

  return skippedSteps;
}

export function getPreparationProgress(
  completedStepIds: PreparationStepId[],
  activeStepId?: PreparationStepId,
  isReady?: boolean
) {
  if (isReady) {
    return 1;
  }

  const completedCount = completedStepIds.length;
  const activeStepBonus = activeStepId ? 0.55 : 0;
  return Math.min(1, (completedCount + activeStepBonus) / preparationSteps.length);
}

export function getOrderStatusLabel(status: DrinkOrderStatus) {
  switch (status) {
    case 'preparing':
      return 'En preparacion';
    case 'ready':
      return 'Listo para servir';
    case 'served':
      return 'Servido';
    case 'failed':
      return 'No completado';
    default:
      return status;
  }
}
