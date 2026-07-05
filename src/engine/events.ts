import type { ActiveEffect, ResourceId } from './types';
import { nextRandom, randomRange } from './rng';

const EVENT_CHANCE = 0.2; // baseline ~20% per turn, per doc §6

interface EventDef {
  id: string;
  kind: 'disaster' | 'lawsuit';
  weight: number;
  label: string;
  build: (rngState: number, tier0ResourceIds: ResourceId[]) => { effect: ActiveEffect; nextState: number };
}

const EVENT_TABLE: EventDef[] = [
  {
    id: 'factory_fire',
    kind: 'disaster',
    weight: 3,
    label: 'Factory fire',
    build: (rngState) => ({
      effect: {
        id: `factory_fire_${rngState}`,
        kind: 'disaster',
        label: 'Factory fire — 30% inventory lost',
        turnsLeft: 1,
        effect: { type: 'outputCut', multiplier: 0.3 },
      },
      nextState: rngState,
    }),
  },
  {
    id: 'crop_failure',
    kind: 'disaster',
    weight: 3,
    label: 'Crop failure',
    build: (rngState, tier0Ids) => {
      const { value, nextState } = nextRandom(rngState);
      const resourceId = tier0Ids[Math.floor(value * tier0Ids.length)] ?? tier0Ids[0];
      return {
        effect: {
          id: `crop_failure_${nextState}`,
          kind: 'disaster',
          label: `Crop failure — ${resourceId} supply down`,
          turnsLeft: 3,
          effect: { type: 'supplyShift', resourceId, multiplier: 0.5 },
        },
        nextState,
      };
    },
  },
  {
    id: 'energy_spike',
    kind: 'disaster',
    weight: 2,
    label: 'Energy price spike',
    build: (rngState) => ({
      effect: {
        id: `energy_spike_${rngState}`,
        kind: 'disaster',
        label: 'Energy price spike — production costs +25% for 3 turns',
        turnsLeft: 3,
        effect: { type: 'costMultiplier', multiplier: 1.25 },
      },
      nextState: rngState,
    }),
  },
  {
    id: 'regulatory_violation',
    kind: 'lawsuit',
    weight: 2,
    label: 'Regulatory violation',
    build: (rngState) => ({
      effect: {
        id: `regulatory_violation_${rngState}`,
        kind: 'lawsuit',
        label: 'Regulatory violation — license suspension risk',
        turnsLeft: 1,
        effect: { type: 'productionHalt' },
      },
      nextState: rngState,
    }),
  },
];

export function rollEvent(
  rngState: number,
  tier0ResourceIds: ResourceId[]
): { event: ActiveEffect | null; nextState: number } {
  const roll = nextRandom(rngState);
  if (roll.value > EVENT_CHANCE) {
    return { event: null, nextState: roll.nextState };
  }
  const totalWeight = EVENT_TABLE.reduce((sum, e) => sum + e.weight, 0);
  const pick = randomRange(roll.nextState, 0, totalWeight);
  let acc = 0;
  let chosen: EventDef = EVENT_TABLE[0];
  for (const e of EVENT_TABLE) {
    acc += e.weight;
    if (pick.value <= acc) {
      chosen = e;
      break;
    }
  }
  const built = chosen.build(pick.nextState, tier0ResourceIds);
  return { event: built.effect, nextState: built.nextState };
}
