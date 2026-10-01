/**
 * Gateway config resolution tests.
 *
 * This is the code an operator debugs from a Render log when the gateway says
 * it has no clinics. The two mistakes worth pinning are a half-set env clinic
 * being reported as absent (so nobody knows which variable to set), and a
 * template/example entry being accepted as a real clinic (so the gateway fails
 * inside Firebase init instead of idling with an explanation).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, envClinic, isPlaceholderClinic, type ClinicConfig } from '../src/config.js';

const REAL = {
  GATEWAY_CLINIC_ID: 'clc_production123',
  GATEWAY_PROJECT_ID: 'mediflow-prod',
  GATEWAY_PHONE_NUMBER: '966501234567',
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gw-config-'));
}

describe('single-clinic env path', () => {
  it('builds a clinic from the three required variables', () => {
    const { clinic, missing } = envClinic(REAL);
    expect(missing).toEqual([]);
    expect(clinic?.clinicId).toBe('clc_production123');
    expect(clinic?.projectId).toBe('mediflow-prod');
    expect(clinic?.phoneNumber).toBe('966501234567');
  });

  it('leaves serviceAccountPath empty so Firebase uses the ambient credential', () => {
    // Non-empty used to mean "read this file". Empty must mean "use
    // GOOGLE_APPLICATION_CREDENTIALS or the metadata service", which is how a
    // platform host provides the key without putting it on disk.
    expect(envClinic(REAL).clinic?.serviceAccountPath).toBe('');
  });

  it('honours an explicit key path and session dir when given', () => {
    const { clinic } = envClinic({
      ...REAL,
      GATEWAY_SERVICE_ACCOUNT_PATH: '/etc/secrets/sa.json',
      GATEWAY_SESSION_DIR: '/data/sessions/wa',
    });
    expect(clinic?.serviceAccountPath).toBe('/etc/secrets/sa.json');
    expect(clinic?.sessionDir).toBe('/data/sessions/wa');
  });

  it('derives a session dir from the clinic id so two clinics never collide', () => {
    expect(envClinic(REAL).clinic?.sessionDir).toContain('clc_production123');
  });

  it('names the missing variable rather than half-configuring a clinic', () => {
    // This is the failure the deploy actually hit: two of three set, so the
    // gateway idled and the log had to say which one was absent.
    const { clinic, missing } = envClinic({
      GATEWAY_CLINIC_ID: 'clc_production123',
      GATEWAY_PHONE_NUMBER: '966501234567',
    });
    expect(clinic).toBeNull();
    expect(missing).toEqual(['GATEWAY_PROJECT_ID']);
  });

  it('reports every name when nothing is set', () => {
    const { clinic, missing } = envClinic({});
    expect(clinic).toBeNull();
    expect(missing).toEqual(['GATEWAY_CLINIC_ID', 'GATEWAY_PROJECT_ID', 'GATEWAY_PHONE_NUMBER']);
  });

  it('ignores whitespace-only values instead of building a blank clinic', () => {
    const { clinic, missing } = envClinic({ ...REAL, GATEWAY_CLINIC_ID: '   ' });
    expect(clinic).toBeNull();
    expect(missing).toEqual(['GATEWAY_CLINIC_ID']);
  });
});

describe('loadConfig precedence', () => {
  it('configures from env with no file present', () => {
    // No GATEWAY_CONFIG at all: a container carrying only tracked files has no
    // real config, and env alone must be enough to run a clinic.
    const loaded = loadConfig({ ...REAL });
    expect(loaded.unconfigured).toBe(false);
    expect(loaded.config.clinics.map((c) => c.clinicId)).toEqual(['clc_production123']);
  });

  it('overrides a same-id file clinic so env can win without deleting the file', () => {
    const dir = tempDir();
    const path = join(dir, 'gateway-config.json');
    writeFileSync(
      path,
      JSON.stringify({
        clinics: [
          {
            clinicId: 'clc_production123',
            projectId: 'from-file',
            serviceAccountPath: '/keys/file.json',
            phoneNumber: '966500000000',
            sessionDir: '/sessions/file',
          },
        ],
      }),
    );
    const loaded = loadConfig({ ...REAL, GATEWAY_CONFIG: path });
    expect(loaded.config.clinics).toHaveLength(1);
    expect(loaded.config.clinics[0]?.projectId).toBe('mediflow-prod');
  });

  it('keeps file clinics whose ids differ from the env clinic', () => {
    const dir = tempDir();
    const path = join(dir, 'gateway-config.json');
    writeFileSync(
      path,
      JSON.stringify({
        clinics: [
          {
            clinicId: 'clc_other',
            projectId: 'other-project',
            serviceAccountPath: '/keys/other.json',
            phoneNumber: '966509999999',
            sessionDir: '/sessions/other',
          },
        ],
      }),
    );
    const loaded = loadConfig({ ...REAL, GATEWAY_CONFIG: path });
    expect(loaded.config.clinics.map((c) => c.clinicId).sort()).toEqual([
      'clc_other',
      'clc_production123',
    ]);
  });

  it('reports unconfigured when the env clinic is incomplete', () => {
    const loaded = loadConfig({ GATEWAY_CLINIC_ID: 'clc_production123' });
    expect(loaded.unconfigured).toBe(true);
    expect(loaded.missingEnv).toEqual(['GATEWAY_PROJECT_ID', 'GATEWAY_PHONE_NUMBER']);
  });

  it('throws when GATEWAY_CONFIG names a file that is not there', () => {
    // Deliberate operator setting: ignoring it would hide a typo behind an
    // idle process that looks healthy.
    expect(() =>
      loadConfig({ GATEWAY_CONFIG: join(tempDir(), 'nope.json') }),
    ).toThrow(/does not exist/);
  });

  it('does not treat a file with no clinics key as configured', () => {
    const dir = tempDir();
    const path = join(dir, 'gateway-config.json');
    writeFileSync(path, JSON.stringify({ sms: { accountSid: 'AC', authToken: 'x' } }));
    const loaded = loadConfig({ GATEWAY_CONFIG: path });
    expect(loaded.unconfigured).toBe(true);
    expect(loaded.config.clinics).toEqual([]);
  });
});

describe('placeholder detection', () => {
  const template: ClinicConfig = {
    clinicId: 'fb-demo-clinic',
    projectId: 'your-firebase-project-id',
    serviceAccountPath: './keys/demo-clinic-sa.json',
    phoneNumber: '966500000000',
    sessionDir: './sessions/fb-demo-clinic',
  };

  it('rejects the shipped example values', () => {
    expect(isPlaceholderClinic(template)).toBe(true);
  });

  it('accepts a real-looking clinic', () => {
    expect(
      isPlaceholderClinic({
        clinicId: 'clc_production123',
        projectId: 'mediflow-prod',
        serviceAccountPath: '',
        phoneNumber: '966501234567',
        sessionDir: '/data/sessions',
      }),
    ).toBe(false);
  });

  it('treats an empty key path as acceptable, not placeholder', () => {
    // Empty means "ambient credential" on a platform host. Flagging it would
    // make every env-configured clinic un-configurable.
    expect(isPlaceholderClinic({ ...template, projectId: 'mediflow-prod', serviceAccountPath: '' })).toBe(
      false,
    );
  });

  it('rejects a clinic whose phone number is still a template value', () => {
    expect(isPlaceholderClinic({ ...template, phoneNumber: '9665xxxxxxx' })).toBe(true);
  });
});
