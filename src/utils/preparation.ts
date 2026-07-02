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
    title: 'Vaso Premium',
    description: 'Colocando un vaso de cristal premium en la estacion.',
    icon: 'glass',
  },
  {
    id: 'ice_dispenser',
    title: 'Hielo de Roca',
    description: 'Agregando hielos macizos para conservar la temperatura optima.',
    icon: 'cube',
  },
  {
    id: 'alcohol_dispenser',
    title: 'Dosificando Licores',
    description: 'Sirviendo las medidas exactas de destilados y licores premium.',
    icon: 'tint',
  },
  {
    id: 'agitation_system',
    title: 'Mezclando Coctel',
    description: 'Agitando suavemente para integrar perfectamente los sabores.',
    icon: 'refresh',
  },
  {
    id: 'carbonated_station',
    title: 'Burbujas de Soda',
    description: 'Completando el coctel con un toque refrescante de gasificado.',
    icon: 'bolt',
  },
  {
    id: 'ready',
    title: 'Listo',
    description: '¡Coctel finalizado con exito y listo para disfrutar!',
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
