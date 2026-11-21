import test from 'node:test';
import assert from 'node:assert/strict';
import { learningProgress } from '../src/tutor-progress.js';
const e=(turn,kind='independent',correct=true)=>({turn,kind,correct,note:'Evidence'});
const state=(evidence=[],level=0)=>({goal:'Independent level 4',phase:'learning',skills:[{id:'a',name:'Proportions',level,evidence}],messages:[]});
test('route has a fixed denominator and specific remaining requirements',()=>{const a=learningProgress(state()),b=learningProgress(state([e(1)]));assert.equal(a.total,6);assert.equal(a.remaining,5);assert.equal(b.total,a.total);assert.equal(b.remaining,4);assert.equal(b.skills[0].steps[1].done,false)});
test('many attempts do not inflate completed milestones',()=>{const s=learningProgress(state(Array.from({length:50},(_,i)=>e(i+1))));assert.equal(s.skills[0].done,1);assert.equal(s.total,6)});
test('recall requires intervening substantive turns and separate successes',()=>{assert.equal(learningProgress(state([e(1),e(3,'recall')])).skills[0].done,1);assert.equal(learningProgress(state([e(1),e(4,'recall')])).skills[0].done,2)});
test('hints never count as independent success',()=>{assert.equal(learningProgress(state([e(1,'assisted')])).skills[0].done,0)});
test('failed review explicitly reopens evidence requirements',()=>{assert.equal(learningProgress(state([e(1),e(4,'recall'),e(5,'independent',false)],3)).skills[0].done,0)});
test('previously earned skill level remains recognized on import',()=>{const p=learningProgress(state([],4));assert.equal(p.skills[0].complete,true);assert.equal(p.skills[0].done,3)});
test('mastery goal includes edge and explanation requirements',()=>{const s=state([e(1),e(4,'recall')],4);s.goal='Full mastery (level 5)';const p=learningProgress(s);assert.equal(p.skills[0].total,5);assert.equal(p.skills[0].done,2);assert.equal(p.readySkills,0)});
test('final assessment coverage excludes learning evidence',()=>{const s=state([e(1),e(4,'recall')],4);s.messages=[{role:'tutor',text:'First?'},{role:'learner',text:'Answer'},{role:'tutor',text:'[Mixed assessment]\nFinal?'}];assert.equal(learningProgress(s).assessment[0].done,true);s.skills[0].evidence=[e(1)];assert.equal(learningProgress(s).assessment[0].done,false)});
test('complete imported sessions show a finished route',()=>{const s=state([],4);s.phase='complete';const p=learningProgress(s);assert.equal(p.remaining,0)});

test('diagnosis does not reveal correctness feedback before placement ends',()=>{const s=state([e(1),e(4,'recall')],4);s.phase='diagnostic';s.diagnosticCount=2;const p=learningProgress(s);assert.equal(p.skills[0].done,0);assert.equal(p.readySkills,0);assert.equal(p.diagnosticDone,false)});
