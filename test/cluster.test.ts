/**
 * The cluster as one location: the Media Index catalog's listing laid over a
 * snapshot, the `onCluster` filter, and the three states the board keeps
 * apart. No test here opens a database: the reader is handed in.
 */

import { describe, expect, it } from 'vitest';
import { makeFixture } from './server/fixture.ts';
import { buildServer } from '../src/server/app.ts';
import { resolveClusterPresence } from '../src/cluster/presence.ts';
import { machineReadState } from '../src/cluster/catalog.ts';
import type { ClusterListing, ClusterFile } from '../src/cluster/catalog.ts';
import { latestSnapshot } from '../src/db/index.ts';

function listing(files: ClusterFile[]): ClusterListing {
  return {
    cluster: 'd3',
    roles: ['actor'],
    machines: [
      { key: '101', role: 'actor', regions: [1], disabled: false, location: 'd3-main', files: 0, bytes: 0, space: { totalBytes: 100_000, freeBytes: 10_000, at: '2026-10-07T10:06:35Z' }, read: { state: 'read', unreadable: [], lastReadAt: '2026-10-07T10:06:41Z' } },
      { key: '206', role: 'actor', regions: [2], disabled: false, location: 'd3-main', files: 0, bytes: 0, space: null, read: { state: 'read', unreadable: [], lastReadAt: '2026-10-07T10:06:41Z' } },
    ],
    scans: [{ location: 'd3-main', lastCompleteAt: '2026-10-07T10:06:41Z', newestStatus: 'complete', newestStartedAt: '2026-10-07T10:06:35Z' }],
    files,
    readAt: '2026-10-07T12:00:00Z',
  };
}

describe('resolveClusterPresence', () => {
  const archive = [
    { id: 1, name: 'A_v001_region1.mov', size: 10, versionId: 100 },
    { id: 2, name: 'A_v001_region2.mov', size: 20, versionId: 100 },
    { id: 3, name: 'A_v002_region1.mov', size: 30, versionId: 200 },
  ];

  it('matches on name ignoring case, and on size', () => {
    const p = resolveClusterPresence(
      listing([
        { machine: '101', name: 'a_v001_REGION1.mov', size: 10 },
        { machine: '206', name: 'A_v001_region2.mov', size: 21 },
      ]),
      archive,
    );
    expect([...p.fileIds]).toEqual([1]);
    expect(p.byVersion.get(100)).toEqual({ files: 1, bytes: 10 });
    expect(p.byVersion.has(200)).toBe(false);
    // A copy at the wrong size is not a copy, and is counted on its own.
    expect(p.sizeMismatchFiles).toBe(1);
  });

  it('counts a file held by two machines once -- the cluster is one location', () => {
    const p = resolveClusterPresence(
      listing([
        { machine: '101', name: 'A_v002_region1.mov', size: 30 },
        { machine: '206', name: 'A_v002_region1.mov', size: 30 },
      ]),
      archive,
    );
    expect(p.matchedFiles).toBe(1);
    expect(p.matchedBytes).toBe(30);
  });

  it('reports what is on the cluster that the archive has no name for', () => {
    const p = resolveClusterPresence(listing([{ machine: '101', name: 'readme.txt', size: 5 }]), archive);
    expect(p.strangerFiles).toBe(1);
    expect(p.strangerBytes).toBe(5);
    expect(p.matchedFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Through the API
// ---------------------------------------------------------------------------

type V = { versionId: number; bytes: number; status: string };

async function server(reader: (() => Promise<ClusterListing>) | null | 'default') {
  const fx = makeFixture();
  const snap = latestSnapshot(fx.db)!;
  const archive = fx.db
    .prepare('SELECT id, name, size, asset_version_id AS v FROM file WHERE snapshot_id = ? ORDER BY id')
    .all(snap.id) as { id: number; name: string; size: number; v: number | null }[];
  const opts = reader === 'default' ? {} : { clusterReader: reader };
  const { app, ctx } = buildServer({ db: fx.db, cfg: fx.cfg, ...opts });
  await app.ready();
  await ctx.cluster.load();
  const get = async (url: string) => app.inject({ method: 'GET', url });
  const post = async (url: string) => app.inject({ method: 'POST', url, payload: {} });
  const close = async () => {
    await app.close();
    fx.db.close();
  };
  return { get, post, close, ctx, archive };
}

/** Every other archive file on the cluster, and one at the wrong size. */
function halfTheArchive(archive: { id: number; name: string; size: number }[]): ClusterFile[] {
  const out: ClusterFile[] = archive
    .filter((_, i) => i % 2 === 0)
    .map((f) => ({ machine: '101', name: f.name, size: f.size }));
  const odd = archive[1]!;
  out.push({ machine: '206', name: odd.name, size: odd.size + 1 });
  out.push({ machine: '206', name: 'stray.mov', size: 7 });
  return out;
}

describe('the onCluster filter', () => {
  it('splits versions and files into on the cluster and not, with nothing lost or doubled', async () => {
    const fixtureArchive = (await server(null)).archive;
    const files = halfTheArchive(fixtureArchive);
    const s = await server(async () => listing(files));

    const all = (await s.get('/api/versions?keepN=1&limit=2000')).json();
    const yes = (await s.get('/api/versions?keepN=1&limit=2000&onCluster=1')).json();
    const no = (await s.get('/api/versions?keepN=1&limit=2000&onCluster=0')).json();
    expect(yes.total).toBeGreaterThan(0);
    expect(no.total).toBeGreaterThan(0);
    expect(yes.total + no.total).toBe(all.total);

    const fAll = (await s.get('/api/files?limit=2000')).json();
    const fYes = (await s.get('/api/files?limit=2000&onCluster=1')).json();
    const fNo = (await s.get('/api/files?limit=2000&onCluster=0')).json();
    expect(fYes.total + fNo.total).toBe(fAll.total);
    // Per FILE in the file list: exactly the archive files whose name the
    // cluster holds at that size. Two archive files may share both (the
    // fixture has a duplicate), and then both are on it.
    const held = new Set(files.map((f) => `${f.name.toLowerCase()}|${f.size}`));
    const onIds = new Set(s.archive.filter((f) => held.has(`${f.name.toLowerCase()}|${f.size}`)).map((f) => f.id));
    expect(onIds.size).toBeGreaterThan(0);
    expect(new Set(fYes.rows.map((r: { id: number }) => r.id))).toEqual(onIds);
    await s.close();
  });

  it('hides rows and changes no verdict', async () => {
    const fixtureArchive = (await server(null)).archive;
    const s = await server(async () => listing(halfTheArchive(fixtureArchive)));
    const all: V[] = (await s.get('/api/versions?keepN=1&limit=2000')).json().rows;
    const yes: V[] = (await s.get('/api/versions?keepN=1&limit=2000&onCluster=1')).json().rows;
    const before = new Map(all.map((r) => [r.versionId, r.status]));
    for (const r of yes) expect(r.status).toBe(before.get(r.versionId));
    await s.close();
  });

  it('puts the superseded bytes the cluster still holds on the board', async () => {
    const fixtureArchive = (await server(null)).archive;
    const s = await server(async () => listing(halfTheArchive(fixtureArchive)));
    const r = (await s.get('/api/reclaim?keepN=1')).json();
    const p = s.ctx.cluster.presence(latestSnapshot(s.ctx.db)!.id)!;
    const sup: V[] = (await s.get('/api/versions?keepN=1&limit=2000&status=superseded')).json().rows;
    const expected = sup.reduce((n, v) => n + (p.byVersion.get(v.versionId)?.bytes ?? 0), 0);
    expect(expected).toBeGreaterThan(0);
    expect(r.clusterReclaimBytes).toBe(expected);
    // Never more than the superseded total: it is a part of it.
    expect(r.clusterReclaimBytes).toBeLessThanOrEqual(r.reclaimBytes);
    expect(r.cluster.usable).toBe(true);
    expect(r.cluster.sizeMismatchFiles).toBe(1);
    expect(r.cluster.strangerFiles).toBe(1);
    expect(r.cluster.scans[0].lastCompleteAt).toBe('2026-10-07T10:06:41Z');
    await s.close();
  });
});

describe('per machine', () => {
  it('frees on each machine the superseded files it holds, and a file on two machines frees on both', async () => {
    const fixtureArchive = (await server(null)).archive;
    const probe = await server(async () => listing([]));
    const sup: V[] = (await probe.get('/api/versions?keepN=1&limit=2000&status=superseded')).json().rows;
    await probe.close();
    const supIds = new Set(sup.map((v) => v.versionId));
    const victim = fixtureArchive.find((f) => f.v !== null && supIds.has(f.v))!;
    const keeper = fixtureArchive.find((f) => f.v !== null && !supIds.has(f.v))!;

    const s = await server(async () =>
      listing([
        { machine: '101', name: victim.name, size: victim.size },
        { machine: '206', name: victim.name, size: victim.size },
        { machine: '101', name: keeper.name, size: keeper.size },
      ]),
    );
    const r = (await s.get('/api/reclaim?keepN=1')).json();
    const by = new Map(r.clusterMachines.map((m: { key: string }) => [m.key, m]));
    const m101 = by.get('101') as { freesBytes: number; freesFiles: number; drive: Record<string, number | string> };
    const m206 = by.get('206') as { freesBytes: number; drive: unknown };
    expect(m101.freesBytes).toBe(victim.size);
    expect(m101.freesFiles).toBe(1);
    expect(m206.freesBytes).toBe(victim.size);
    // Once on the cluster, however many machines hold it.
    expect(r.clusterReclaimBytes).toBe(victim.size);

    // Measured drive: 100,000 total, 10,000 free, 5% reserve.
    expect(m101.drive.capacityBytes).toBe(100_000);
    expect(m101.drive.usableBytes).toBe(95_000);
    expect(m101.drive.usedFraction).toBeCloseTo(90_000 / 95_000);
    expect(m101.drive.afterFraction).toBeCloseTo((90_000 - victim.size) / 95_000);
    // No reading is null, never an empty drive.
    expect(m206.drive).toBeNull();
    await s.close();
  });

  it('follows the filters: hiding a superseded version frees nothing for it', async () => {
    const fixtureArchive = (await server(null)).archive;
    const s = await server(async () =>
      listing(fixtureArchive.map((f) => ({ machine: '101', name: f.name, size: f.size }))),
    );
    const all = (await s.get('/api/reclaim?keepN=1')).json();
    const none = (await s.get('/api/reclaim?keepN=1&q=no_such_thing_anywhere')).json();
    expect(all.clusterMachines[0].freesBytes).toBeGreaterThan(0);
    expect(none.clusterMachines[0].freesBytes).toBe(0);
    await s.close();
  });
});

describe('three states, never one', () => {
  it('not configured: no cluster block, and the filter refuses', async () => {
    // The fixture config has no mediaIndex, so the default reader is none.
    const s = await server('default');
    const r = (await s.get('/api/reclaim?keepN=1')).json();
    expect(r.cluster).toBeNull();
    expect(r.clusterReclaimBytes).toBeNull();
    const res = await s.get('/api/versions?onCluster=1');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('no_cluster');
    await s.close();
  });

  it('unreadable: a warning with the reason, never an empty listing', async () => {
    const s = await server(async () => {
      throw new Error('Media Index catalog not reachable: connect ECONNREFUSED 127.0.0.1:5432');
    });
    const r = (await s.get('/api/reclaim?keepN=1')).json();
    expect(r.cluster).toEqual({ usable: false, error: expect.stringContaining('ECONNREFUSED') });
    expect(r.clusterReclaimBytes).toBeNull();
    const res = await s.get('/api/files?onCluster=0');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('cluster_unavailable');
    await s.close();
  });

  it('a failed reload leaves the listing in force, and says so', async () => {
    let fail = false;
    const s = await server(async () => {
      if (fail) throw new Error('catalog went away');
      return listing([{ machine: '101', name: 'stray.mov', size: 7 }]);
    });
    fail = true;
    const res = await s.post('/api/cluster/reload');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/still in force/);
    const r = (await s.get('/api/reclaim?keepN=1')).json();
    expect(r.cluster.usable).toBe(true);
    expect(r.cluster.error).toBe('catalog went away');
    expect(r.cluster.strangerFiles).toBe(1);
    await s.close();
  });

  it('reload answers 409 when no catalog is configured', async () => {
    const s = await server('default');
    expect((await s.post('/api/cluster/reload')).statusCode).toBe(409);
    await s.close();
  });
});

describe('whether the last scan read a machine', () => {
  const at = (h: number) => `2026-10-07T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('read, partly read, and not read are three answers', () => {
    expect(machineReadState('301', [{ finishedAt: at(10), unreadable: [] }])).toEqual({
      state: 'read',
      unreadable: [],
      lastReadAt: at(10),
    });
    expect(machineReadState('301', [{ finishedAt: at(10), unreadable: ['301/objects/VideoFile/x'] }])).toEqual({
      state: 'partly',
      unreadable: ['301/objects/VideoFile/x'],
      lastReadAt: at(10),
    });
    // Not read: its files are as of the newest scan that reached it.
    expect(
      machineReadState('306', [
        { finishedAt: at(10), unreadable: ['306'] },
        { finishedAt: at(8), unreadable: ['306'] },
        { finishedAt: at(6), unreadable: [] },
      ]),
    ).toEqual({ state: 'not-read', unreadable: ['306'], lastReadAt: at(6) });
  });

  it('owns only its own paths, with either separator', () => {
    // 30 is not 301's prefix; a Windows agent sends backslashes; '.' is all.
    expect(machineReadState('30', [{ finishedAt: at(10), unreadable: ['301', '301/a'] }])!.state).toBe('read');
    expect(machineReadState('301', [{ finishedAt: at(10), unreadable: ['301\\a'] }])!.state).toBe('partly');
    expect(machineReadState('301', [{ finishedAt: at(10), unreadable: ['.'] }])!.state).toBe('not-read');
  });

  it('never read in the scans searched: no last read, and no completed scan: null', () => {
    expect(machineReadState('301', [{ finishedAt: at(10), unreadable: ['301'] }])!.lastReadAt).toBeNull();
    expect(machineReadState('301', [])).toBeNull();
  });
});

describe('clusterRoles: fresh actors without stale understudies', () => {
  /** 101 an actor, 207 an understudy scanned at another time. */
  function withUnderstudy(files: ClusterFile[]): ClusterListing {
    const l = listing(files);
    return {
      ...l,
      roles: ['actor', 'understudy'],
      machines: [
        ...l.machines,
        { key: '207', role: 'understudy', regions: [1, 2], disabled: false, location: 'd3-us', files: 0, bytes: 0, space: null, read: { state: 'read', unreadable: [], lastReadAt: '2026-10-06T10:00:00Z' } },
      ],
      scans: [...l.scans, { location: 'd3-us', lastCompleteAt: '2026-10-06T10:00:00Z', newestStatus: 'complete', newestStartedAt: '2026-10-06T09:59:00Z' }],
    };
  }

  async function setup() {
    const fixtureArchive = (await server(null)).archive;
    const probe = await server(async () => listing([]));
    const sup: V[] = (await probe.get('/api/versions?keepN=1&limit=2000&status=superseded')).json().rows;
    await probe.close();
    const supIds = new Set(sup.map((v) => v.versionId));
    const victim = fixtureArchive.find((f) => f.v !== null && supIds.has(f.v))!;
    // Only the understudy lists it.
    const s = await server(async () => withUnderstudy([{ machine: '207', name: victim.name, size: victim.size }]));
    return { s, victim };
  }

  it('counts every role by default, and only the named ones when asked', async () => {
    const { s, victim } = await setup();
    const all = (await s.get('/api/reclaim?keepN=1')).json();
    const actors = (await s.get('/api/reclaim?keepN=1&clusterRoles=actor')).json();
    expect(all.clusterReclaimBytes).toBeGreaterThanOrEqual(victim.size);
    expect(actors.clusterReclaimBytes).toBe(0);
    expect(all.cluster.countedRoles).toEqual(['actor', 'understudy']);
    expect(actors.cluster.countedRoles).toEqual(['actor']);
    expect(actors.cluster.clusterFiles).toBe(0);
    // It hides nothing by itself, so the board is not "filtered" by it.
    expect(actors.filtered).toBe(false);
    expect(actors.reclaimBytes).toBe(all.reclaimBytes);
    await s.close();
  });

  it('scopes the onCluster filter, and changes no verdict', async () => {
    const { s, victim } = await setup();
    const all: V[] = (await s.get('/api/versions?keepN=1&limit=2000')).json().rows;
    const anyRole: V[] = (await s.get('/api/versions?keepN=1&limit=2000&onCluster=1')).json().rows;
    const actorsOnly: V[] = (await s.get('/api/versions?keepN=1&limit=2000&onCluster=1&clusterRoles=actor')).json().rows;
    expect(anyRole.map((r) => r.versionId)).toContain(victim.v);
    expect(actorsOnly.map((r) => r.versionId)).not.toContain(victim.v);
    const before = new Map(all.map((r) => [r.versionId, r.status]));
    for (const r of anyRole) expect(r.status).toBe(before.get(r.versionId));
    await s.close();
  });

  it('still draws every machine, and says which are counted', async () => {
    const { s, victim } = await setup();
    const r = (await s.get('/api/reclaim?keepN=1&clusterRoles=actor')).json();
    const m207 = r.clusterMachines.find((m: { key: string }) => m.key === '207');
    expect(m207.counted).toBe(false);
    expect(m207.freesBytes).toBe(victim.size);
    expect(r.clusterMachines.find((m: { key: string }) => m.key === '101').counted).toBe(true);
    await s.close();
  });

  it('refuses a role the listing was not read for', async () => {
    const { s } = await setup();
    for (const url of ['/api/reclaim?keepN=1&clusterRoles=director', '/api/versions?onCluster=1&clusterRoles=actr']) {
      const res = await s.get(url);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_cluster_role');
    }
    // Empty is absent, as for every parameter: every role counts.
    expect((await s.get('/api/reclaim?keepN=1&clusterRoles=')).json().cluster.countedRoles).toEqual(['actor', 'understudy']);
    await s.close();
  });
});
