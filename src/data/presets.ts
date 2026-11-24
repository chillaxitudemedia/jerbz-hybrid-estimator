export interface JobsitePreset {
  id: string;
  label: string;
  trade: string;
  clientName: string;
  siteLocation: string;
  notes: string;
}

export const JOBSITE_PRESETS: JobsitePreset[] = [
  {
    id: 'hvac-rtu',
    label: 'HVAC Rooftop Compressor',
    trade: 'HVAC',
    clientName: 'Summit Medical Plaza',
    siteLocation: 'Roof Mechanical Deck B (No Cell Signal)',
    notes:
      'Basement mechanical room + roof RTU #3 inspection. Carrier 5-ton unit tripping high pressure switch, condenser fan motor bearings seized, contactor pitted. Need 1x 1/3 HP condenser fan motor ($185), 1x 40A 2-pole contactor ($38), 1x dual run capacitor 45/5 MFD ($26), 4 lbs R-410A refrigerant ($34/lb), 1x liquid line filter drier ($42), and 2 cans coil cleaner ($18/ea). About 6 hours labor for 1 tech, urgent because clinic exam rooms are at 81F.',
  },
  {
    id: 'electrical-panel',
    label: '200A Panel Upgrade',
    trade: 'Electrical',
    clientName: 'Harborview Coffee Roasters',
    siteLocation: 'Utility Sub-Basement',
    notes:
      'Sub-basement main service upgrade from 100A Federal Pacific to 200A Square D QO panel. Zero reception down here. Need 1x 200A 40-space QO load center ($295), 2x 50A 2-pole breakers for roaster ($44/ea), 8x 20A single-pole AFCI/GFCI breakers ($56/ea), 25 ft 2/0 copper SER cable ($11/ft), 2x 8ft copper ground rods with clamps ($36/ea), 1x 2-inch weatherhead & mast kit ($95), and permit/inspection fee ($175). 2 days work, ~14 hours total labor.',
  },
  {
    id: 'plumbing-remodel',
    label: 'Commercial Restroom Rough-In',
    trade: 'Plumbing',
    clientName: 'Redwood Dental Group',
    siteLocation: 'Suite 210 — Concrete Vault Wing',
    notes:
      'ADA restroom rough-in & fixture swap. Replacing cracked floor-mount toilet and corroded supply stops. Materials: 1x Kohler Highline ADA commercial toilet ($340), 1x Sloan Royal flushometer valve ($215), 1x wall-hung vitreous china lavatory ($190), 1x Chicago Faucets metering faucet ($245), 40 ft 3/4-inch Type L copper pipe ($6.50/ft), 12x ProPress 3/4 elbows/couplings ($9/ea), 2x brass quarter-turn angle stops ($16/ea), 1x wax ring & closet bolt kit ($14). Estimate 1.5 days, 10 labor hours, normal priority.',
  },
];
