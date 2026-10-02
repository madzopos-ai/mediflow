/**
 * Upserts one clinic entry into a gateway-config.json file.
 *
 * Used by Setup-MediFlow.bat so the operator never hand-edits JSON:
 *   node tools/local-server/add-clinic.cjs <configPath> <clinicId> <projectId> <phone> <sessionDir> <serviceAccountPath>
 *
 * Matches by clinicId OR phoneNumber (re-running for the same clinic updates
 * instead of duplicating). Also importable: require('./add-clinic.cjs')
 * exposes upsertClinic() for add-doctor.cjs.
 */

const fs = require('node:fs');

function upsertClinic(configPath, entry) {
  const { clinicId, projectId, phone, sessionDir, serviceAccountPath } = entry;
  if (!clinicId || !projectId || !phone) {
    throw new Error('clinicId, projectId and phone are required.');
  }
  if (!/^[0-9]{7,15}$/.test(phone)) {
    throw new Error('Phone must be digits only with country code, e.g. 96170123456.');
  }
  let config = { clinics: [] };
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(config.clinics)) config.clinics = [];
  }
  config.clinics = config.clinics.filter(
    (c) => c.clinicId !== clinicId && c.phoneNumber !== phone,
  );
  config.clinics.push({
    clinicId,
    projectId,
    serviceAccountPath: serviceAccountPath || '',
    phoneNumber: phone,
    sessionDir: sessionDir || `./sessions/${clinicId}`,
  });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  return config.clinics.length;
}

function main() {
  const [configPath, clinicId, projectId, phone, sessionDir, serviceAccountPath] = process.argv.slice(2);
  try {
    const n = upsertClinic(configPath, { clinicId, projectId, phone, sessionDir, serviceAccountPath });
    console.log(`Gateway config now holds ${n} clinic(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('Usage: node add-clinic.cjs <configPath> <clinicId> <projectId> <phone> <sessionDir> <serviceAccountPath>');
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { upsertClinic };
