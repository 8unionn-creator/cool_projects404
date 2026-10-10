# Wan2.2 short story

Makes a short AI-generated video story with [Wan2.2](https://github.com/Wan-Video/Wan2.2), an open-source video generation model. It uses the TI2V-5B model, the smallest one, which makes 5-second 720p clips at 24 fps.

The included story, **"The Lantern Fox"**, has 5 shots, about 25 seconds in total. A small fox finds a glowing lantern in a snowy forest and carries it home.

## What you need

- Linux with an NVIDIA GPU with **24 GB+ of memory** (RTX 4090, A100, L40S, …). Wan2.2 doesn't run on CPU or a Mac.
- CUDA, Python 3.10–3.12, `git`, `ffmpeg`
- About 50 GB of free disk space (the model is ~34 GB)

No GPU? A rented cloud GPU (RunPod, Lambda, Vast.ai, …) with an RTX 4090 works.

## Make the video

```bash
cd wan2.2
./setup.sh         # clones Wan2.2, installs it, downloads the model
./make_story.sh    # writes output/story.mp4
```

Each shot takes about 9 minutes on an RTX 4090, so the whole story takes about 45 minutes.

## How it works

- `story.txt` has one prompt per line, one line per 5-second shot.
- Shot 1 is generated from its text alone. Each later shot also gets the **last frame of the shot before it** as a starting image, so the fox and the scene stay consistent across cuts.
- A line of `---` starts a **new scene**: the next shot starts fresh from its text alone. Use it at chapter or location changes, or every 8–10 shots, so long stories don't drift.
- At the end, `ffmpeg` joins the shots into `output/story.mp4`.

## Make your own story

Edit `story.txt` and run `./make_story.sh` again. Tips:
- Describe the main character the same way in every line ("the same red fox with a white-tipped tail").
- One action per shot. 5 seconds is short.
- Add the camera move and light ("slow push-in", "blue dusk light").
- Split long stories into scenes with `---`:

```
The red fox wakes up in a snowy forest at dusk.
The red fox trots toward a warm glow.
---
Morning. The red fox sleeps curled up by a cabin door, the lantern beside it.
```

`DRY_RUN=1 ./make_story.sh` checks the pipeline with test-pattern clips, without a GPU.
