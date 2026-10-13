import {validateRound} from './engine.js';
export const KEY='golf-hussein-v1';
export function load(storage){const raw=storage.getItem(KEY);if(!raw)return [];return parseBackup(raw);}
export function save(storage,rounds){storage.setItem(KEY,JSON.stringify({version:1,rounds}));}
export function parseBackup(raw){const data=JSON.parse(raw);if(data.version!==1||!Array.isArray(data.rounds)||data.rounds.length>500)throw Error('지원하지 않는 백업 파일입니다.');const ids=new Set();for(const r of data.rounds){validateRound(r);if(typeof r.id!=='string'||ids.has(r.id))throw Error('라운드 ID가 올바르지 않습니다.');ids.add(r.id);if(!Number.isInteger(r.current)||r.current<0||r.current>17)throw Error('현재 홀 번호가 올바르지 않습니다.');}return data.rounds;}
