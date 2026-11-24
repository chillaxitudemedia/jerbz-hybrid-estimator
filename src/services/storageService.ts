import type { InferenceTelemetry, JobEstimate } from '../types';

const ESTIMATES_KEY = 'jerbz_fieldscope_estimates_v1';
const TELEMETRY_KEY = 'jerbz_fieldscope_telemetry_v1';

export function loadLocalEstimates(): JobEstimate[] {
  try {
    const raw = localStorage.getItem(ESTIMATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveLocalEstimates(estimates: JobEstimate[]): void {
  try {
    localStorage.setItem(ESTIMATES_KEY, JSON.stringify(estimates));
  } catch {
    // Ignore storage quota errors in private browsing
  }
}

export function loadTelemetryLog(): InferenceTelemetry[] {
  try {
    const raw = localStorage.getItem(TELEMETRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTelemetryLog(log: InferenceTelemetry[]): void {
  try {
    localStorage.setItem(TELEMETRY_KEY, JSON.stringify(log.slice(0, 50)));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Exports an estimate in a JSON structure directly compatible with
 * Jerbz Enterprise / Standard Edition (`Poso` + `StavkaMaterijala`).
 */
export function buildJerbzExportPayload(estimate: JobEstimate) {
  const materialsSubtotal = estimate.materials.reduce(
    (sum, item) => sum + item.ukupno,
    0
  );
  const laborSubtotal =
    estimate.estimatedLaborHours * estimate.laborRatePerHour;
  const totalEstimate = materialsSubtotal + laborSubtotal;

  return {
    schema: 'jerbz.poso.v1',
    exportedAt: new Date().toISOString(),
    sourceApp: 'jerbz-hybrid-estimator',
    poso: {
      id: estimate.id,
      nazivPosla: estimate.title,
      opisPosla: estimate.jobDescription,
      klijent: estimate.clientName,
      lokacija: estimate.siteLocation,
      kategorija: estimate.tradeCategory,
      prioritet: estimate.priority,
      procijenjeniDani: estimate.estimatedDurationDays,
      satiRada: estimate.estimatedLaborHours,
      satnicaUsd: estimate.laborRatePerHour,
      ukupnoMaterijalUsd: Number(materialsSubtotal.toFixed(2)),
      ukupnoRadUsd: Number(laborSubtotal.toFixed(2)),
      ukupnaVrijednostUsd: Number(totalEstimate.toFixed(2)),
      stavkeMaterijala: estimate.materials.map((m) => ({
        naziv: m.naziv,
        kolicina: m.kolicina,
        jedinica: m.jedinica,
        jedinicnaCijena: m.jedinicnaCijena,
        ukupno: m.ukupno,
      })),
      preporuceniKoraci: estimate.recommendedNextSteps,
      klijentskaPonuda: estimate.clientQuoteDraft ?? '',
      aiTelemetry: estimate.lastInference ?? null,
    },
  };
}
