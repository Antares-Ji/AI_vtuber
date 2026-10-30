import json
import sys
from pathlib import Path
from unittest.mock import Mock
import requests
from PIL import Image

repo = Path(r'E:\Github\GameScaling')
sys.path.insert(0, str(repo))
from gamescaling import GameScalingPolicy, PolicyConfig, parse_action

results = {}
raw = '<|action_start|>5000 -5000 9 ; A B C D E ; Foo W ; ; ; ; <|action_end|>'
a = parse_action(raw)
results['normalized_action_vs_history'] = {
    'executed_mouse': a.mouse, 'executed_steps': a.steps,
    'dropped': a.dropped, 'history': a.history_text, 'normalized_text': a.to_text(),
}
results['nonfinite_numbers'] = {}
for value in ('nan', 'inf', '-inf'):
    a = parse_action(f'<|action_start|>{value} 0 0 ; W ; ; ; ; ; <|action_end|>')
    results['nonfinite_numbers'][value] = {'parsed': a.parsed, 'mouse': a.mouse}
results['short_action'] = vars(parse_action('<|action_start|>0 0 0 ; W<|action_end|>'))

frame = Image.new('RGB', (32, 18), color='black')
valid_reply = {'choices': [{'message': {'content': '\n\n</think>\n\n<|action_start|>0 0 0 ; W ; ; ; ; ; '}, 'finish_reason': 'stop'}], 'usage': {'completion_tokens': 30}}

def session_for(payload):
    response = Mock(status_code=200)
    response.json.return_value = payload
    session = Mock()
    session.post.return_value = response
    return session

policy = GameScalingPolicy('test', PolicyConfig(history_len=2))
policy._session = session_for(valid_reply)
for _ in range(3):
    decision = policy.act(frame)
assert decision.action.parsed and decision.action.steps[0] == ['W']
assert len(policy._history) == 2
results['valid_mock_roundtrip'] = {'parsed': decision.action.parsed, 'history_len': len(policy._history), 'completion_tokens': decision.completion_tokens}

policy = GameScalingPolicy('test')
policy._session = Mock()
policy._session.post.side_effect = requests.Timeout('simulated timeout')
decision = policy.act(frame)
assert decision.action.is_noop and decision.error
results['timeout_mock'] = {'noop': decision.action.is_noop, 'error': decision.error}

bad_payloads = {
    'json_array': [],
    'null_choice': {'choices': [None]},
    'content_list': {'choices': [{'message': {'content': [{'type': 'text', 'text': 'hello'}]}}]},
}
results['malformed_responses'] = {}
for label, payload in bad_payloads.items():
    policy = GameScalingPolicy('test')
    policy._session = session_for(payload)
    try:
        decision = policy.act(frame)
        results['malformed_responses'][label] = {'raised': False, 'error': decision.error}
    except Exception as exc:
        results['malformed_responses'][label] = {'raised': True, 'type': type(exc).__name__, 'message': str(exc)}

print(json.dumps(results, ensure_ascii=False, indent=2))
