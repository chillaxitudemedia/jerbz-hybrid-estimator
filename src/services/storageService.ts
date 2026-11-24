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
 * Exports an estimate in a clean structured JSON payload ready for import
 * into the Jerbz commercial field-service platform.
 */
export function buildJerbzExportPayload(estimate: JobEstimate) {
  const materialsSubtotal = estimate.materials.reduce(
    (sum, item) => sum + item.lineTotal,
    0
  );
  const laborSubtotal =
    estimate.estimatedLaborHours * estimate.laborRatePerHour;
  const totalEstimate = materialsSubtotal + laborSubtotal;

  return {
    schema: 'jerbz.estimate.v1',
    exportedAt: new Date().toISOString(),
    sourceApp: 'jerbz-hybrid-estimator',
    estimate: {
      id: estimate.id,
      jobTitle: estimate.title,
      jobDescription: estimate.jobDescription,
      clientName: estimate.clientName,
      siteLocation: estimate.siteLocation,
      tradeCategory: estimate.tradeCategory,
      priority: estimate.priority,
      estimatedDurationDays: estimate.estimatedDurationDays,
      laborHours: estimate.estimatedLaborHours,
      laborRateUsd: estimate.laborRatePerHour,
      materialsSubtotalUsd: Number(materialsSubtotal.toFixed(2)),
      laborSubtotalUsd: Number(laborSubtotal.toFixed(2)),
      totalEstimateUsd: Number(totalEstimate.toFixed(2)),
      materials: estimate.materials.map((m) => ({
        name: m.name,
        quantity: m.quantity,
        unit: m.unit,
        unitPriceUsd: m.unitPrice,
        lineTotalUsd: m.lineTotal,
      })),
      recommendedNextSteps: estimate.recommendedNextSteps,
      clientQuoteDraft: estimate.clientQuoteDraft ?? '',
      aiTelemetry: estimate.lastInference ?? null,
    },
  };
}
