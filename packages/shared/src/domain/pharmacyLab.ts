/**
 * Pharmacy & Lab data models - INERT SCAFFOLD, ready for activation.
 *
 * Types, API tables and routes exist, but nothing reads or writes them yet:
 * the API answers `{ enabled: false }` and the admin console shows both
 * modules as disabled placeholders. Flip `PHARMACY_LAB_ENABLED` (and the
 * matching server env flag) to activate without refactoring core logic.
 */

export const PHARMACY_LAB_ENABLED = false;

export type DispenseStatus = 'pending' | 'partial' | 'dispensed' | 'cancelled';

export type LabOrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface PharmacyInventoryItem {
  id: string;
  clinicId: string;
  drugName: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
  batchNumber: string | null;
  quantity: number;
  unit: string;
  unitPriceMinor: number;
  currency: string;
  expiresAt: string | null;
  supplier: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrescriptionDispense {
  id: string;
  clinicId: string;
  prescriptionId: string;
  patientId: string;
  status: DispenseStatus;
  items: { drug: string; quantity: number }[];
  dispensedBy: string | null;
  dispensedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LabTestCatalogItem {
  code: string;
  name: string;
  category: string | null;
  prepNotes: string | null;
  routinePriceMinor: number | null;
  currency: string;
}

export interface LabOrder {
  id: string;
  clinicId: string;
  patientId: string;
  testCode: string;
  testName: string;
  status: LabOrderStatus;
  resultJson: Record<string, number | string> | null;
  technicianNotes: string | null;
  orderedBy: string | null;
  orderedAt: string;
  completedAt: string | null;
}
