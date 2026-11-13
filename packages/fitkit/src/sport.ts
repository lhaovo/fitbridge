import type { SportType } from './types.js';

/**
 * FIT profile 运动类型 → 归一化 SportType。
 *
 * FIT 的 sport 可能是字符串（'cycling'）或数字（profile 枚举 id）。
 * 数字 id 的映射参考 Garmin FIT profile 的 sport 枚举顺序。
 */
const FIT_SPORT_NAMES = [
  'generic',
  'running',
  'cycling',
  'transition',
  'fitness_equipment',
  'swimming',
  'basketball',
  'soccer',
  'tennis',
  'american_football',
  'training',
  'walking',
  'cross_country_skiing',
  'alpine_skiing',
  'snowboarding',
  'rowing',
  'mountaineering',
  'hiking',
  'multisport',
  'paddling',
  'flying',
  'e_biking',
  'motorcycling',
  'boating',
  'driving',
  'golf',
  'hang_gliding',
  'horseback_riding',
  'hunting',
  'fishing',
  'inline_skating',
  'rock_climbing',
  'sailing',
  'ice_skating',
  'sky_diving',
  'snowshoeing',
  'snowmobiling',
  'stand_up_paddleboarding',
  'surfing',
  'wind_surfing',
  'kitesurfing',
  'tactical',
  'jumpmaster',
  'boxing',
  'floor_climbing',
  'baseball',
  'diving',
  'shooting',
  'archery',
  'hunting_dog',
  'fishing_dog',
  'inline_skating_dog',
] as const;

export function mapFitSport(raw: string | number | undefined): {
  sportType: SportType;
  rawSportType?: string;
} {
  if (raw === undefined || raw === null) return { sportType: 'other' };

  const name = typeof raw === 'number' ? FIT_SPORT_NAMES[raw] : raw;
  if (!name) return { sportType: 'other', rawSportType: String(raw) };

  switch (name) {
    case 'cycling':
    case 'e_biking':
    case 'motorcycling':
      return { sportType: 'ride', rawSportType: name };
    case 'running':
      return { sportType: 'run', rawSportType: name };
    case 'walking':
    case 'hiking':
    case 'mountaineering':
      return { sportType: 'hiking', rawSportType: name };
    case 'swimming':
      return { sportType: 'swim', rawSportType: name };
    case 'rowing':
    case 'paddling':
    case 'stand_up_paddleboarding':
    case 'surfing':
    case 'wind_surfing':
    case 'kitesurfing':
    case 'sailing':
      return { sportType: 'rowing', rawSportType: name };
    case 'cross_country_skiing':
    case 'alpine_skiing':
    case 'snowboarding':
    case 'skiing':
      return { sportType: 'ski', rawSportType: name };
    case 'fitness_equipment':
    case 'training':
      return { sportType: 'strength', rawSportType: name };
    default:
      return { sportType: 'other', rawSportType: name };
  }
}
