/**
 * `@mediflow/shared` public surface.
 *
 * Everything the API and the PWA share lives here: domain enums, serialisable
 * entity contracts, money/time/id helpers, and the clinical safety library.
 * Both consumers import from the package root so internal file layout can move
 * without touching application code.
 */

export * from './domain/enums.js';
export * from './domain/types.js';
export * from './domain/pharmacyLab.js';

export * from './core/money.js';
export * from './core/time.js';
export * from './core/ids.js';
export * from './core/result.js';
export * from './core/logger.js';
export * from './core/patientAccount.js';

export * from './clinical/vitals.js';
export * from './clinical/replyParser.js';
export * from './clinical/labPanel.js';
export * from './clinical/practice.js';
export * from './clinical/dosingGuidance.js';
export * from './clinical/lifestyle.js';
export * from './clinical/specialty.js';
export * from './clinical/drugs.js';
export * from './clinical/interactions.js';
export * from './clinical/allergies.js';
export * from './clinical/dosing.js';
export * from './clinical/protocols.js';
export * from './clinical/decisionSupport.js';
export * from './clinical/arabicNumbers.js';
export * from './clinical/voiceSummary.js';

export * from './whatsapp/templates.js';
export * from './whatsapp/commands.js';
export * from './whatsapp/outbox.js';
export * from './whatsapp/care.js';
export * from './scheduling/slots.js';
export * from './scheduling/waitlist.js';
export * from './scheduling/reminders.js';
export * from './scheduling/deposit.js';

export * from './scheduling/slots.js';
export * from './scheduling/deposit.js';
export * from './scheduling/waitlist.js';
export * from './scheduling/reminders.js';
