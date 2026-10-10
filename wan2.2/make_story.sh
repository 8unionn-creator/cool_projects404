#!/usr/bin/env bash
# Makes one video from story.txt: generates each shot with Wan2.2, then joins them.
# Usage: ./make_story.sh [story.txt]
# DRY_RUN=1 ./make_story.sh   makes test-pattern clips instead, to check the pipeline without a GPU.
set -euo pipefail
cd "$(dirname "$0")"

STORY=${1:-story.txt}
OUT=output
SIZE=1280*704   # landscape 720p; use 704*1280 for vertical
SEED=42         # same seed for every shot keeps the look consistent
mkdir -p "$OUT"
rm -f "$OUT"/shot_*.mp4 "$OUT"/shot_*_last.png "$OUT"/clips.txt

n=0
prev_frame=""
while IFS= read -r prompt <&3; do
  [[ -z "$prompt" || "$prompt" == \#* ]] && continue
  n=$((n + 1))
  clip=$(printf '%s/shot_%02d.mp4' "$OUT" "$n")
  echo "== Shot $n: ${prompt:0:70}..."

  if [ "${DRY_RUN:-0}" = 1 ]; then
    ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x704:rate=24:duration=5" \
      -vf "drawtext=text='Shot $n':fontsize=72:fontcolor=white:x=(w-tw)/2:y=(h-th)/2" \
      -pix_fmt yuv420p "$clip"
  else
    args=(--task ti2v-5B --size "$SIZE" --ckpt_dir ../Wan2.2-TI2V-5B
          --offload_model True --convert_model_dtype --t5_cpu
          --base_seed "$SEED" --save_file "../$clip" --prompt "$prompt")
    # Later shots continue from the previous shot's last frame.
    [ -n "$prev_frame" ] && args+=(--image "../$prev_frame")
    (cd Wan2.2 && ../.venv/bin/python generate.py "${args[@]}")
  fi

  prev_frame="${clip%.mp4}_last.png"
  ffmpeg -loglevel error -y -sseof -0.1 -i "$clip" -frames:v 1 -update 1 "$prev_frame"
  echo "file '$(basename "$clip")'" >> "$OUT/clips.txt"
done 3< "$STORY"

ffmpeg -loglevel error -y -f concat -safe 0 -i "$OUT/clips.txt" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT/story.mp4"
echo "Done: $OUT/story.mp4 ($n shots)"
