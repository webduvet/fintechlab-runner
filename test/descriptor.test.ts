import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { descriptorProblems, mergeStandIns, validateDescriptor, type Plugin } from '../src/descriptor';

const good = (): Plugin => ({
    id: 'my-platform',
    name: 'My platform',
    base_url: 'http://host.containers.internal:3109',
    browse_url: 'http://127.0.0.1:3109',
    health_path: '/status',
    activity_path: '/sim/activity',
    clock: 'follows',
    actions: [{ id: 'sweep', label: 'Sweep', path: '/sim/sweep', primary: true }],
    settlement: { files_path: '/sim/files', run_path: '/sim/run', status_path: '/status', runs_log: 'runs' },
    empty_hints: { runs: 'No run yet.' },
    stand_ins: { receiver: { connected: false, shown: false }, settlement: { shown: true } },
});

describe('descriptor', () => {
    it('accepts a well-formed descriptor', () => {
        assert.deepEqual(descriptorProblems(good()), []);
        assert.equal(validateDescriptor(good()).id, 'my-platform');
    });

    it('refuses what the console refuses, naming each field', () => {
        const p = good();
        p.id = 'Bad_Id';
        p.base_url = 'ftp://x';
        p.health_path = 'status';
        p.clock = 'maybe' as Plugin['clock'];
        p.actions = [
            { id: 'a', label: 'A', path: '/a' },
            { id: 'a', label: '', path: '/../etc', method: 'GET' as 'POST' },
        ];
        p.empty_hints = { 'Not A Log': 'x' };
        const problems = descriptorProblems(p).join('\n');
        for (const expected of [
            'id "Bad_Id"',
            'base_url "ftp://x"',
            'health_path "status"',
            'clock must be',
            'action id "a" must be unique',
            'action a needs a label',
            'method "GET"',
            'action a path "/../etc"',
            'empty_hints key "Not A Log"',
        ]) {
            assert.ok(problems.includes(expected), `missing: ${expected}\n${problems}`);
        }
        assert.throws(() => validateDescriptor(p), /plugin descriptor Bad_Id/);
    });

    it("refuses one of the lab's own ids, and more than eight actions", () => {
        const p = good();
        p.id = 'receiver';
        p.actions = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, label: 'x', path: '/x' }));
        const problems = descriptorProblems(p);
        assert.ok(problems.some((m) => m.includes("one of the lab's own services")));
        assert.ok(problems.some((m) => m.includes('at most 8 actions')));
    });

    it('accepts action fields and refuses malformed ones', () => {
        const p = good();
        p.actions = [
            {
                id: 'seed',
                label: 'Seed',
                path: '/seed',
                fields: [
                    { id: 'merchants', label: 'Merchants', type: 'number', default: 50, min: 1, max: 5000 },
                    { id: 'dir', label: 'Write to', type: 'text', placeholder: '.runs/generated' },
                    {
                        id: 'mode',
                        label: 'Mode',
                        type: 'select',
                        default: 'add',
                        options: [
                            { value: 'add', label: 'Add' },
                            { value: 'reseed', label: 'Reseed' },
                        ],
                    },
                ],
            },
        ];
        assert.deepEqual(descriptorProblems(p), []);

        p.actions[0]!.fields = [
            { id: 'Bad-Id', label: '', type: 'number', min: 5, max: 1 },
            { id: 'n', label: 'N', type: 'number', default: 'ten' as unknown as number },
            { id: 'pick', label: 'Pick', type: 'select', default: 'z', options: [{ value: 'a', label: 'A' }] },
            { id: 'empty', label: 'Empty', type: 'select', options: [] },
            { id: 'when', label: 'When', type: 'date' as 'text' },
        ];
        const problems = descriptorProblems(p).join('\n');
        for (const expected of [
            'field id "Bad-Id"',
            'field Bad-Id needs a label',
            'min is above max',
            'field n: default must be a number',
            'default "z" is not one of its options',
            'field empty: a select needs 1 to 20 options',
            'type "date"',
        ]) {
            assert.ok(problems.includes(expected), `missing: ${expected}\n${problems}`);
        }
        p.actions[0]!.fields = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, label: 'x', type: 'text' as const }));
        assert.ok(descriptorProblems(p).some((m) => m.includes('at most 6 fields')));
    });

    it('checks stand_ins shape', () => {
        const p = good();
        p.stand_ins = { receiver: { connected: 'no' as unknown as boolean, colour: true } as never };
        const problems = descriptorProblems(p).join('\n');
        assert.match(problems, /stand_ins\.receiver\.connected must be true or false/);
        assert.match(problems, /stand_ins\.receiver\.colour is not a stand-in field/);
    });

    it('merges stand-ins field by field', () => {
        assert.equal(mergeStandIns(undefined, undefined), undefined);
        assert.deepEqual(
            mergeStandIns(
                { receiver: { connected: false, shown: false }, settlement: { connected: false, shown: false } },
                { settlement: { shown: true }, notifier: { connected: true } }
            ),
            {
                receiver: { connected: false, shown: false },
                settlement: { connected: false, shown: true },
                notifier: { connected: true },
            }
        );
    });
});
