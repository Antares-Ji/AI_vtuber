"""Atomic, conservative battle action journal. No game, model or input imports."""
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4


def plan_hash(plan):
    return hashlib.sha256(json.dumps(plan, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode('utf8')).hexdigest()


def _names(plan):
    rows = plan.get('plan', []) if isinstance(plan, dict) else plan
    names = [row['name'] for row in rows]
    if not names or len(set(names)) != len(names):
        raise ValueError('Plan names must be nonempty and unique')
    return names


def _evidence(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Current visual evidence reference is required')
    return value


class BattleCheckpoint:
    """Use an explicit battle/run id and file; never select a latest journal.

    begin_* must run BEFORE native input. A persisted inflight action is not
    permission to replay it, even if the process stopped before sending input.
    """
    def __init__(self, path, state):
        self.path = Path(path)
        self.state = state
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_file = self.path.with_name(self.path.name + '.lock').open('a+b')
        try:
            if self.lock_file.seek(0, 2) == 0:
                self.lock_file.write(b'0')
                self.lock_file.flush()
            self.lock_file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.close()
            raise ValueError('Checkpoint is owned by another active runner') from error

    def close(self):
        # OS ownership ends on close or process termination; no stale-lock guess.
        if self.lock_file is not None:
            self.lock_file.close()
            self.lock_file = None

    @classmethod
    def create(cls, path, plan, battle_id, initial_remaining=8):
        if not isinstance(battle_id, str) or not battle_id.strip():
            raise ValueError('Explicit battle id required')
        if type(initial_remaining) is not int or not 1 <= initial_remaining <= 8:
            raise ValueError('Invalid initial remaining count')
        checkpoint = cls(path, dict(version=1, battle_id=battle_id, plan_hash=plan_hash(plan),
            names=_names(plan), initial_remaining=initial_remaining, deployed=[],
            sequence=0, inflight=None, skills={}, actions=[], blocked=None))
        if Path(path).exists():
            checkpoint.close()
            raise ValueError('Existing checkpoint must be loaded, never overwritten')
        checkpoint._save()
        return checkpoint

    @classmethod
    def load(cls, path, plan, battle_id):
        checkpoint = cls(path, None)
        try:
            state = json.loads(Path(path).read_text(encoding='utf8'))
            cls._validate_state(state, plan, battle_id)
            checkpoint.state = state
            return checkpoint
        except Exception:
            checkpoint.close()
            raise

    @staticmethod
    def _validate_state(state, plan, battle_id):
        if state.get('version') != 1 or state.get('battle_id') != battle_id:
            raise ValueError('Checkpoint battle identity differs')
        if state.get('plan_hash') != plan_hash(plan) or state.get('names') != _names(plan):
            raise ValueError('Checkpoint plan differs')
        deployed = state.get('deployed')
        if not isinstance(deployed, list) or deployed != state['names'][:len(deployed)]:
            raise ValueError('Checkpoint deployed prefix is invalid')
        if type(state.get('sequence')) is not int or state['sequence'] != len(state.get('actions', [])):
            raise ValueError('Checkpoint action sequence is invalid')

    def _save(self):
        if self.lock_file is None:
            raise ValueError('Checkpoint runner is closed')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + '.' + uuid4().hex + '.tmp')
        try:
            with temporary.open('w', encoding='utf8') as output:
                json.dump(self.state, output, ensure_ascii=False, indent=2)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _remaining(self):
        return self.state['initial_remaining'] - len(self.state['deployed'])

    def _begin(self, kind, name, evidence):
        if self.state['inflight'] is not None or self.state['blocked']:
            raise ValueError('Unresolved checkpoint blocks new input; no automatic replay')
        sequence = self.state['sequence'] + 1
        action = dict(sequence=sequence, kind=kind, name=name, evidence=_evidence(evidence), status='inflight')
        self.state['sequence'] = sequence
        self.state['actions'].append(action)
        self.state['inflight'] = sequence
        return action

    def begin_deploy(self, name, before_remaining, evidence):
        deployed = self.state['deployed']
        if len(deployed) >= len(self.state['names']) or name != self.state['names'][len(deployed)]:
            raise ValueError('Deployment is not the next undeployed plan entry')
        if type(before_remaining) is not int or before_remaining != self._remaining() or before_remaining <= 0:
            raise ValueError('Current deployment counter does not match checkpoint')
        self._begin('deploy', name, evidence)['before_remaining'] = before_remaining
        self._save()

    def confirm_deploy(self, name, after_remaining, evidence):
        action = self._inflight('deploy', name)
        if type(after_remaining) is not int or after_remaining != action['before_remaining'] - 1:
            raise ValueError('Landing counter not confirmed')
        action.update(status='confirmed', after_remaining=after_remaining, confirmation=_evidence(evidence))
        self.state['deployed'].append(name)
        self.state['inflight'] = None
        self._save()

    def _inflight(self, kind, name):
        if self.state['inflight'] is None:
            raise ValueError('No inflight action to confirm')
        action = self.state['actions'][self.state['inflight'] - 1]
        if action['kind'] != kind or action['name'] != name or action['status'] != 'inflight':
            raise ValueError('Inflight action does not match confirmation')
        return action

    def begin_skill(self, name, evidence):
        if name not in self.state['deployed'] or name in self.state['skills']:
            raise ValueError('Skill unit must be deployed and not previously attempted')
        action = self._begin('skill', name, evidence)
        self.state['skills'][name] = dict(attempt_recorded=True, verified=False, sequence=action['sequence'])
        self._save()

    def confirm_skill(self, name, evidence):
        action = self._inflight('skill', name)
        action.update(status='confirmed', confirmation=_evidence(evidence))
        self.state['skills'][name]['verified'] = True
        self.state['inflight'] = None
        self._save()

    def block(self, reason, evidence):
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError('Blocked reason required')
        self.state['blocked'] = dict(reason=reason, evidence=_evidence(evidence))
        self._save()

    def reconcile(self, remaining, verified_names, battle_id, evidence):
        """Accept CURRENT visual identities + counter; never infer names from count.

        Returns pending if an input may not have happened. That state remains
        inflight, preventing another deploy or skill. Skill recovery requires
        explicit visual confirmation through confirm_skill, not a counter.
        """
        _evidence(evidence)
        if self.state['blocked']:
            raise ValueError('Blocked checkpoint requires explicit visual recovery; cannot continue')
        if battle_id != self.state['battle_id'] or type(remaining) is not int:
            raise ValueError('Unknown or mismatching current battle observation')
        if not isinstance(verified_names, list) or verified_names != self.state['names'][:len(verified_names)]:
            raise ValueError('Current deployed identities do not match plan prefix')
        if remaining != self.state['initial_remaining'] - len(verified_names):
            raise ValueError('Counter differs from visually verified deployed identities')
        deployed = self.state['deployed']
        if verified_names == deployed:
            return 'pending' if self.state['inflight'] is not None else 'confirmed'
        if self.state['inflight'] is not None:
            action = self.state['actions'][self.state['inflight'] - 1]
            if action['kind'] == 'deploy' and verified_names == deployed + [action['name']]:
                self.confirm_deploy(action['name'], remaining, evidence)
                return 'confirmed'
        raise ValueError('Current deployment change has no matching inflight action')
