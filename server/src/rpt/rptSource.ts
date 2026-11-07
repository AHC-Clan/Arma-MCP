// rptSource.ts — client/server RPT 위치 선택.
//
// source=auto 는 현재 라이브 텔레메트리가 dedicated 세션을 가리킬 때만
// 서버 profiles 를 선택한다. 연결이 끊기면 TelemetryStore 가 current() 를
// 비우므로, 알 수 없는 상태에서는 기존 호환 동작인 client RPT 로 돌아간다.

import type { Config } from '../config.js';
import { resolveServerProfilesDir } from '../config.js';
import type { TelemetryStore } from '../game/telemetry.js';
import { CLIENT_RPT_RE, SERVER_RPT_RE } from './rptFiles.js';

export type RptSource = 'auto' | 'client' | 'server';
export type ResolvedRptSource = Exclude<RptSource, 'auto'>;

export interface RptScope {
  source: ResolvedRptSource;
  dir: string;
  re: RegExp;
}

export class RptSourceResolver {
  constructor(
    private cfg: Config,
    private clientRptDir: string,
    private telemetry: TelemetryStore,
    /** 클라 i(1부터)의 RPT 폴더. 없으면 클라 1 폴더만 안다. */
    private clientDirOf?: (index: number) => string,
  ) {}

  /** client 는 client 소스일 때 클라 순번이다(기본 1). */
  resolve(requested: RptSource = 'auto', client = 1): RptScope {
    const source: ResolvedRptSource =
      requested === 'auto'
        ? this.telemetry.current().dedicated
          ? 'server'
          : 'client'
        : requested;

    return source === 'server'
      ? {
          source,
          dir: resolveServerProfilesDir(this.cfg),
          re: SERVER_RPT_RE,
        }
      : {
          source,
          dir: client > 1 && this.clientDirOf ? this.clientDirOf(client) : this.clientRptDir,
          re: CLIENT_RPT_RE,
        };
  }
}
