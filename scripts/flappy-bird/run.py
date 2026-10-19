"""Reproducible benchmark and visible playback of the downloaded game."""
import os
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")

import argparse
import hashlib
import importlib.metadata
import json
from datetime import datetime, timezone
from pathlib import Path
import time
import sys

import gymnasium as gym
import pygame
import flappy_bird_gymnasium  # Registers the environment.
from agent import PretrainedDQN, GuardedDQN

ROOT = Path(__file__).resolve().parents[2]


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes", type=int, default=10, help="0 = continuous demo")
    parser.add_argument("--target", type=int, default=100)
    parser.add_argument("--seed", type=int, default=10000)
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--policy", choices=("pretrained", "guarded"), default="guarded")
    parser.add_argument("--max-steps", type=int, default=100000)
    parser.add_argument("--output", type=Path, default=ROOT / "runtime/flappy-bird/evaluation.json")
    args = parser.parse_args()
    if args.episodes < 0 or args.target < 1 or args.max_steps < 1:
        parser.error("episodes must be nonnegative; target and max-steps must be positive")
    agent = GuardedDQN() if args.policy == "guarded" else PretrainedDQN()
    # Keep default physics, 100-pixel gaps, original collision detection and rewards.
    # No score limit: finishing a benchmark never masquerades as a game win.
    env = gym.make("FlappyBird-v0", use_lidar=False, render_mode="human" if args.render else None)
    started = time.perf_counter()
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "policy": args.policy,
        "model_sha256": hashlib.sha256(agent.path.read_bytes()).hexdigest(),
        "agent_source_sha256": hashlib.sha256((Path(__file__).parent / "agent.py").read_bytes()).hexdigest(),
        "game_source_sha256": hashlib.sha256((Path(flappy_bird_gymnasium.__file__).parent / "envs/flappy_bird_env.py").read_bytes()).hexdigest(),
        "package_versions": {name: importlib.metadata.version(name) for name in
                             ("flappy-bird-gymnasium", "gymnasium", "numpy", "pygame")},
        "settings": {"pipe_gap": 100, "use_lidar": False, "render": args.render,
                     "target_pipes": args.target, "seed_start": args.seed,
                     "requested_episodes": args.episodes, "max_steps": args.max_steps},
        "episodes": [], "status": "running",
    }
    save_json(args.output, report)
    n = 0
    try:
        while args.episodes == 0 or n < args.episodes:
            seed = args.seed + n
            obs, info = env.reset(seed=seed)
            initial_observation = obs.tolist()
            episode_start = time.perf_counter()
            interventions_start = getattr(agent, "interventions", 0)
            unsafe_start = getattr(agent, "no_safe_continuation", 0)
            reward_sum = 0.0
            reason = "step_limit"
            for step in range(1, args.max_steps + 1):
                if args.render:
                    if step % 30 == 1 and (args.output.parent / "stop-demo").exists():
                        raise KeyboardInterrupt
                    for event in pygame.event.get():
                        if event.type == pygame.QUIT or (event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE):
                            raise KeyboardInterrupt
                obs, reward, terminated, truncated, info = env.step(agent.act(obs))
                reward_sum += reward
                if args.render and (step % 30 == 0 or terminated):
                    pygame.display.set_caption(f"Flappy Bird AI | score {info['score']} | episode {n + 1} | Esc to stop")
                    save_json(args.output.parent / "live-status.json", {
                        "pid": os.getpid(), "seed": seed, "score": info["score"], "steps": step,
                        "policy": args.policy, "game_seconds": round(step / 30, 2),
                        "guard_interventions": getattr(agent, "interventions", 0) - interventions_start,
                        "updated_at": datetime.now(timezone.utc).isoformat(), "terminated": terminated,
                    })
                if args.render and step % 300 == 0:
                    pygame.image.save(env.unwrapped._surface, str(args.output.parent / "live-frame.png"))
                if terminated:
                    reason = "collision"
                    break
                if truncated:
                    reason = "environment_truncated"
                    break
                if info["score"] >= args.target:
                    reason = "target_reached_alive"
                    break
            result = {"seed": seed, "score": info["score"], "steps": step,
                      "initial_observation": initial_observation,
                      "game_seconds": round(step / 30, 2), "reason": reason,
                      "reward": round(reward_sum, 3),
                      "guard_interventions": getattr(agent, "interventions", 0) - interventions_start,
                      "no_safe_continuation": getattr(agent, "no_safe_continuation", 0) - unsafe_start,
                      "wall_seconds": round(time.perf_counter() - episode_start, 3)}
            report["episodes"].append(result)
            n += 1
            print(json.dumps({k: v for k, v in result.items() if k != "initial_observation"}), flush=True)
            scores = [r["score"] for r in report["episodes"]]
            report["summary"] = {"episodes": n, "min_score": min(scores), "mean_score": sum(scores) / n,
                                 "max_score": max(scores), "collisions": sum(r["reason"] == "collision" for r in report["episodes"]),
                                 "successes": sum(r["reason"] == "target_reached_alive" for r in report["episodes"])}
            save_json(args.output, report)
        report["status"] = "completed"
    except KeyboardInterrupt:
        report["status"] = "stopped_by_user"
    except Exception as exc:
        report["status"] = "failed"
        report["error"] = repr(exc)
        raise
    finally:
        report["wall_seconds"] = round(time.perf_counter() - started, 3)
        save_json(args.output, report)
        env.close()
        if args.render:
            save_json(args.output.parent / "live-status.json", {
                "pid": os.getpid(), "status": report["status"],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
    print(json.dumps(report.get("summary", {})), flush=True)
    if report["status"] == "completed" and report["summary"]["successes"] != args.episodes:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
