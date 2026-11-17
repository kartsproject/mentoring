#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  K예술영재 미술 멘토링 — 녹화 조각 합치기 (Ver.2.0)
#
#  · 녹화가 중간에 다시 시작돼 같은 단계가 여러 파일(조각)로 나뉜 경우 → 한 파일로 이어 붙임
#  · 「예비 녹화」 PC의 파일이 있으면 → 주 녹화가 비는 곳을 예비 녹화로 채움(내용이 끊기지 않게)
#  · 자리 맞추기는 녹화 화면이 함께 저장한 「_녹화기록_….tsv」(파일별 시작 시각)를 씀
#  · 단계별 파일(전체_분반전 · 분반1~4 · 전체_분반후)은 서로 합치지 않음
#  · 조각만 이어 붙이면 화질 손실 없이 바로(다시 압축 안 함), 예비 녹화로 채우면 다시 압축(몇 분)
#  · 원본은 지우지 않음: 주 녹화 조각 → 「_조각원본」, 같은 폴더의 예비 녹화 → 「_예비녹화원본」
#
#  실행: 더블클릭(맥) → 녹화 폴더 고르기.   터미널: bash 이파일 <녹화폴더> [예비녹화폴더]
#  필요: ffmpeg (처음 한 번: brew install ffmpeg)
# ─────────────────────────────────────────────────────────────
export LANG=ko_KR.UTF-8 LC_ALL=ko_KR.UTF-8 2>/dev/null
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
TAB=$(printf '\t')
HERE="$(cd "$(dirname "$0")" && pwd)"
MEM="$HOME/.karts_rec_dir"
ART_NFC="_미술_"
ART_NFD="$(printf '_\xe1\x84\x86\xe1\x85\xb5\xe1\x84\x89\xe1\x85\xae\xe1\x86\xaf_')"

say() { printf '%s\n' "$*"; }
bye() { say ""; [ -t 0 ] && [ -z "$NO_WAIT" ] && read -r -p "엔터를 누르면 창이 닫힙니다…" _; exit "${1:-0}"; }

say "■ K예술영재 미술 멘토링 — 녹화 조각 합치기 (Ver.2.0)"
say ""

# ① ffmpeg
FF="$(command -v ffmpeg)"; FP="$(command -v ffprobe)"
[ -z "$FF" ] && [ -x "$HERE/ffmpeg" ] && FF="$HERE/ffmpeg"
[ -z "$FP" ] && [ -x "$HERE/ffprobe" ] && FP="$HERE/ffprobe"
if [ -z "$FF" ] || [ -z "$FP" ]; then
  say "✖ ffmpeg가 설치되어 있지 않습니다."
  say "  터미널에서 아래 한 줄을 실행한 뒤 다시 더블클릭하세요(Homebrew가 있어야 함):"
  say "    brew install ffmpeg"
  bye 1
fi

# ② 폴더
is_rec() { printf '%s' "$1" | grep -Eq '^[0-9]{6}_[0-9]{4}_.*\.(mp4|webm)$' || return 1; case "$1" in *"$ART_NFC"*|*"$ART_NFD"*) return 0 ;; esac; return 1; }
has_rec() { local f; for f in "$1"/*; do is_rec "$(basename "$f")" && return 0; done; return 1; }
pick() {   # $1 안내 문구, $2 기본 폴더
  if command -v osascript >/dev/null 2>&1; then
    local def=""; [ -d "$2" ] && def=" default location POSIX file \"$2\""
    osascript -e "POSIX path of (choose folder with prompt \"$1\"$def)" 2>/dev/null
  else local x; read -r -p "$1: " x; printf '%s' "$x"; fi
}
DIR="${1:-}"
if [ -z "$DIR" ]; then
  if has_rec "$HERE"; then DIR="$HERE"
  else LAST=""; [ -f "$MEM" ] && LAST="$(cat "$MEM")"; DIR="$(pick "녹화 파일이 저장된 폴더(주 녹화)를 고르세요" "$LAST")"; fi
fi
DIR="${DIR%/}"
[ -d "$DIR" ] || { say "✖ 폴더를 고르지 않았습니다."; bye 1; }
printf '%s' "$DIR" > "$MEM" 2>/dev/null
BK="${2:-}"
if [ -z "$BK" ] && [ -z "$NO_ASK" ] && ! ls "$DIR" | grep -q '_예비PC' && command -v osascript >/dev/null 2>&1; then
  A="$(osascript -e 'button returned of (display dialog "예비 녹화 PC의 녹화 파일이 따로 있나요?\n(있으면 주 녹화가 끊긴 부분을 채웁니다)" buttons {"없음", "예비 녹화 폴더 고르기"} default button 1)' 2>/dev/null)"
  [ "$A" = "예비 녹화 폴더 고르기" ] && BK="$(pick "예비 녹화 파일이 있는 폴더를 고르세요" "$DIR")"
fi
BK="${BK%/}"
say "주 녹화 폴더: $DIR"
[ -n "$BK" ] && say "예비 녹화 폴더: $BK"
say ""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/karts_merge.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

dur() {   # 길이(초) — 파일을 끝까지 읽어 확인(브라우저 녹화 파일은 길이 정보가 없을 수 있음)
  "$FF" -nostdin -v error -stats -i "$1" -map 0 -c copy -f null - 2>&1 | tr '\r' '\n' | grep -o 'time=[0-9:.]*' | tail -1 |
    awk -F'[=:]' '{ printf "%.3f", $2*3600 + $3*60 + $4 }'
}
has_audio() { [ -n "$("$FP" -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1" </dev/null 2>/dev/null | head -1)" ]; }
vsig() { "$FP" -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,pix_fmt -of csv=p=0 "$1" </dev/null 2>/dev/null | head -1; }
asig() { "$FP" -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "$1" </dev/null 2>/dev/null | head -1; }
vok() {   # 영상이 실제로 풀리는지(녹화가 굶어 영상이 깨진 조각 가려내기)
  "$FF" -nostdin -v error -stats -i "$1" -map 0:v:0 -frames:v 5 -f null - 2>&1 | tr '\r' '\n' | grep -o 'frame= *[0-9]*' | tail -1 | grep -qv 'frame= *0$'
}
fmt() { awk -v s="$1" 'BEGIN { s = int(s + .5); printf "%d:%02d:%02d", s/3600, (s%3600)/60, s%60 }'; }

# ③ 녹화 기록표(파일 이름 → 시작 시각 ms)
: > "$WORK/starts.tsv"
for d in "$DIR" "$BK"; do
  [ -n "$d" ] || continue
  for t in "$d"/_녹화기록_*.tsv; do [ -f "$t" ] && tail -n +2 "$t" | cut -f1,2 >> "$WORK/starts.tsv"; done
done

# ④ 파일 목록: 단계 이름 · 구분(P 주/B 예비) · 시작(ms) · 날짜시각 · -번호 · 경로 · 확장자
: > "$WORK/list.tsv"
scan() {   # $1 폴더, $2 기본 구분
  local f b ext core stamp rest n role ms
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    b="$(basename "$f")"; is_rec "$b" || continue
    case "$b" in *_이어붙임.*) continue ;; esac
    [ "$(wc -c < "$f" | tr -d ' ')" -lt 20000 ] && continue          # 빈 파일·깨진 파일 제외
    ext="${b##*.}"; core="${b%.*}"; stamp="${b:0:11}"; rest="${core:12}"
    n=1; if printf '%s' "$rest" | grep -Eq -- '-[0-9]+$'; then n="${rest##*-}"; rest="${rest%-*}"; fi
    role="$2"; case "$rest" in *_예비PC) role=B; rest="${rest%_예비PC}" ;; esac
    ms="$(awk -F'\t' -v k="$b" '$1 == k { print $2; exit }' "$WORK/starts.tsv")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$rest" "$role" "${ms:-}" "$stamp" "$n" "$f" "$ext" >> "$WORK/list.tsv"
  done
}
scan "$DIR" P
[ -n "$BK" ] && [ "$BK" != "$DIR" ] && scan "$BK" B
sort -t "$TAB" -k1,1 -k2,2 -k4,4 -k5,5n "$WORK/list.tsv" -o "$WORK/list.tsv"
[ -s "$WORK/list.tsv" ] || { say "✖ 이 폴더에 미술 멘토링 녹화 파일이 없습니다."; bye 1; }
cut -f1 "$WORK/list.tsv" | uniq > "$WORK/keys.txt"

VT=""; "$FF" -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox && VT=1
did=0
while IFS= read -r key <&3; do
  [ -n "$key" ] || continue
  awk -F'\t' -v k="$key" '$1 == k' "$WORK/list.tsv" > "$WORK/g.tsv"
  nP=$(awk -F'\t' '$2 == "P"' "$WORK/g.tsv" | wc -l | tr -d ' ')
  nB=$(awk -F'\t' '$2 == "B"' "$WORK/g.tsv" | wc -l | tr -d ' ')
  [ "$nP" -le 1 ] && [ "$nB" -eq 0 ] && continue          # 한 파일뿐 — 할 일 없음
  ls "$DIR" | grep -qF -- "_${key}_이어붙임." && continue   # 이미 합친 단계(다시 실행해도 덮어쓰지 않음)

  # 조각별 길이·형식
  : > "$WORK/p.tsv"; i=0
  while IFS="$TAB" read -r _ role ms stamp n f ext; do
    i=$((i + 1)); d="$(dur "$f")"; [ -z "$d" ] && continue
    vok "$f" || role="W$role"   # 영상이 깨진 조각: 다른 녹화가 없을 때만 씀(소리는 살림)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$i" "$role" "$ms" "$d" "$f" "$(vsig "$f")" "$(has_audio "$f" && asig "$f")" >> "$WORK/p.tsv"
  done < "$WORK/g.tsv"

  # 이어 붙일 계획: 주 녹화 우선, 빈 곳은 예비 녹화로 → SEG(경로·시작·끝·구분) / GAP(초) / MODE
  awk -F'\t' -v OFS='\t' '
    { ro[NR]=$2; ms[NR]=$3; du[NR]=$4+0; pa[NR]=$5; n=NR; if ($3 == "") noal = 1 }
    END {
      # 우선순위: 1 주 녹화 · 2 예비 녹화 · 3 영상이 깨진 조각(소리만이라도)
      nP = 0; for (i = 1; i <= n; i++) { pr[i] = (ro[i] == "P") ? 1 : (ro[i] == "B") ? 2 : 3; if (pr[i] == 1) nP++ }
      if (noal) {   # 기록표가 없으면 순서대로 주 녹화만 이어 붙임
        for (i = 1; i <= n; i++) if (ro[i] == "P" || ro[i] == "WP") print "SEG", pa[i], 0, du[i], ro[i]
        print "MODE", "noalign"; exit
      }
      EPS = 0.05; ws = 1e18; we = -1e18
      for (i = 1; i <= n; i++) { st[i] = ms[i] / 1000; en[i] = st[i] + du[i]
        if (ro[i] == "P" || ro[i] == "WP") { if (st[i] < ws) ws = st[i]; if (en[i] > we) we = en[i] } }
      if (ws > 1e17) for (i = 1; i <= n; i++) { if (st[i] < ws) ws = st[i]; if (en[i] > we) we = en[i] }
      for (i = 1; i <= n; i++) if (ro[i] == "B" || ro[i] == "WB") {   # 예비 녹화가 앞뒤로 1.5초 넘게 더 있으면 그만큼 늘림
        if (st[i] < ws - 1.5) ws = st[i]; if (en[i] > we + 1.5) we = en[i] }
      t = ws; guard = 0
      while (t < we - EPS && guard++ < 10000) {
        c = 0
        for (q = 1; q <= 3 && !c; q++)
          for (j = 1; j <= n; j++) if (pr[j] == q && st[j] <= t + EPS && en[j] > t + EPS) { if (!c || st[j] > st[c]) c = j }
        # 지금 조각을 쓰다가 더 좋은(우선순위가 같거나 높은) 조각이 시작되면 거기서 바꿈
        np = we; for (j = 1; j <= n; j++) if (st[j] > t + EPS && st[j] < np && (!c || pr[j] <= pr[c])) np = st[j]
        if (c) { e = (en[c] < np ? en[c] : np); if (e - t > 0.2) { print "SEG", pa[c], t - st[c], e - st[c], ro[c]; if (pr[c] > 1) fill += e - t }; t = e; continue }
        if (np - t > 0.3) print "GAP", np - t
        t = np
      }
      print "MODE", (fill > 0 ? "fill" : "join")
    }' "$WORK/p.tsv" > "$WORK/plan.tsv"

  nseg=$(grep -c '^SEG' "$WORK/plan.tsv")
  mode=$(awk -F'\t' '$1 == "MODE" { print $2 }' "$WORK/plan.tsv")
  [ "$nseg" -eq 0 ] && continue
  # 주 녹화 1개를 처음부터 끝까지 그대로 쓰게 되면(예비 녹화로 채울 곳 없음) → 할 일 없음
  if [ "$nseg" -eq 1 ] && [ "$mode" != fill ] && [ "$nP" -eq 1 ]; then continue; fi

  first="$(awk -F'\t' '$2 == "P" { print $4; exit }' "$WORK/g.tsv")"; [ -z "$first" ] && first="$(head -1 "$WORK/g.tsv" | cut -f4)"
  ext="$(head -1 "$WORK/g.tsv" | cut -f7)"
  say "▶ $key — 주 녹화 ${nP}개$([ "$nB" -gt 0 ] && printf ' · 예비 녹화 %s개' "$nB")"
  [ "$mode" = noalign ] && say "   (녹화 기록표가 없어 파일 순서대로 이어 붙입니다)"
  total=0
  while IFS="$TAB" read -r tag p a b r; do
    if [ "$tag" = SEG ]; then
      total=$(awk -v x="$total" -v a="$a" -v b="$b" 'BEGIN { print x + b - a }')
      say "   · $(case "$r" in B) printf '[예비] ' ;; WP|WB) printf '[영상 깨짐 — 소리만] ' ;; esac)$(basename "$p")  $(fmt "$a")~$(fmt "$b")"
    elif [ "$tag" = GAP ]; then
      say "   ! 주·예비 녹화 모두 없는 곳 $(awk -v x="$p" 'BEGIN { printf "%.1f", x }')초 — 이 부분은 비어 있습니다$(case "$key" in *분반[0-9]*) grep -q '분반_4분할' "$WORK/keys.txt" && printf ' (그 시간은 「분반_4분할」 파일에 있습니다)' ;; esac)"
    fi
  done < "$WORK/plan.tsv"

  # 그대로 이어 붙일 수 있나: 주 녹화만 · 각 조각을 처음부터 씀 · 화면 형식이 모두 같음
  copy=1
  [ "$mode" = fill ] && [ "$nP" -gt 0 ] && copy=""
  awk -F'\t' '$1 == "SEG" { r[$5] = 1; if ($5 ~ /^W/) bad = 1 } END { k = 0; for (x in r) k++; exit !(bad || k > 1) }' "$WORK/plan.tsv" && copy=""
  awk -F'\t' '$1 == "SEG" && $3 > 0.05 { bad = 1 } END { exit !bad }' "$WORK/plan.tsv" && copy=""
  [ "$(cut -f6 "$WORK/p.tsv" | sort -u | wc -l | tr -d ' ')" -gt 1 ] && copy=""

  tmp="$WORK/out.$ext"; okd=""; od=0
  if [ -n "$copy" ]; then
    sig="$(awk -F'\t' '$7 != "" { print $7; exit }' "$WORK/p.tsv")"
    : > "$WORK/concat.txt"; i=0
    while IFS="$TAB" read -r tag p a b r; do
      [ "$tag" = SEG ] || continue
      i=$((i + 1)); src="$p"
      if [ -n "$sig" ] && ! has_audio "$p"; then   # 소리 없는 조각에는 무음을 넣어 맞춤
        R=$(printf '%s' "$sig" | cut -d, -f2); CH=$(printf '%s' "$sig" | cut -d, -f3)
        AC=aac; [ "$ext" = webm ] && AC=libopus
        src="$WORK/part$i.$ext"
        "$FF" -nostdin -v error -y -i "$p" -f lavfi -i "anullsrc=r=${R:-48000}:cl=$([ "$CH" = 1 ] && echo mono || echo stereo)" \
          -map 0:v -map 1:a -c:v copy -c:a "$AC" -shortest "$src" || src="$p"
      fi
      q=$(printf '%s' "$src" | sed "s/'/'\\\\''/g")
      printf "file '%s'\n" "$q" >> "$WORK/concat.txt"
      d0=$(awk -F'\t' -v p="$p" '$5 == p { print $4 }' "$WORK/p.tsv")
      awk -v b="$b" -v d="$d0" 'BEGIN { exit !(b < d - 0.05) }' && printf 'outpoint %s\n' "$b" >> "$WORK/concat.txt"
    done < "$WORK/plan.tsv"
    MOV=""; [ "$ext" = mp4 ] && MOV="-movflags +faststart"
    if "$FF" -nostdin -v error -y -f concat -safe 0 -fflags +genpts -i "$WORK/concat.txt" -map 0 -c copy $MOV "$tmp"; then
      od=$(dur "$tmp"); okd=$(awk -v o="${od:-0}" -v t="$total" 'BEGIN { print (o >= t - 2.5 - t * 0.02 && o <= t + 2.5 + t * 0.02) ? 1 : "" }')
    fi
  fi
  if [ -z "$okd" ]; then   # 다시 압축해 정확한 자리에서 이어 붙임
    say "   (정확히 이어 붙이려고 다시 압축합니다 — 1시간 분량에 몇 분 걸립니다)"
    ext=mp4; tmp="$WORK/out.mp4"
    set --; FG=""; LBL=""; i=0
    while IFS="$TAB" read -r tag p a b r; do
      [ "$tag" = SEG ] || continue
      L=$(awk -v a="$a" -v b="$b" 'BEGIN { printf "%.3f", b - a }')
      set -- "$@" -err_detect ignore_err -i "$p"
      case "$r" in
        W*) FG="${FG}color=black:s=1920x1080:r=24,format=yuv420p,trim=duration=$L,setpts=PTS-STARTPTS[v$i];" ;;
        *)  FG="$FG[$i:v]trim=start=$a:end=$b,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=24,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=3,trim=duration=$L,setpts=PTS-STARTPTS[v$i];" ;;
      esac
      if has_audio "$p"; then
        FG="$FG[$i:a]atrim=start=$a:end=$b,asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=$L,asetpts=PTS-STARTPTS[a$i];"
      else
        FG="${FG}anullsrc=r=48000:cl=stereo,atrim=duration=$L[a$i];"
      fi
      LBL="$LBL[v$i][a$i]"; i=$((i + 1))
    done < "$WORK/plan.tsv"
    FG="$FG${LBL}concat=n=$i:v=1:a=1[v][a]"
    if [ -n "$VT" ]; then VC="-c:v h264_videotoolbox -b:v 6M"; else VC="-c:v libx264 -preset veryfast -b:v 6M"; fi
    "$FF" -nostdin -v error -max_error_rate 1 -y "$@" -filter_complex "$FG" -map '[v]' -map '[a]' $VC -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart "$tmp" &&
      { od=$(dur "$tmp"); okd=$(awk -v o="${od:-0}" -v t="$total" 'BEGIN { print (o >= t - 1.5 - t * 0.01 && o <= t + 1.5 + t * 0.01) ? 1 : "" }'); }
  fi
  out="$DIR/${first}_${key}_이어붙임.$ext"
  if [ -n "$okd" ]; then
    mv -f "$tmp" "$out"
    while IFS="$TAB" read -r _ role _ _ _ f _; do
      [ "$(dirname "$f")" = "$DIR" ] || continue
      if [ "$role" = B ] || [ "$role" = WB ]; then mkdir -p "$DIR/_예비녹화원본"; mv -n "$f" "$DIR/_예비녹화원본/"
      else mkdir -p "$DIR/_조각원본"; mv -n "$f" "$DIR/_조각원본/"; fi
    done < "$WORK/g.tsv"
    say "   ✔ $(basename "$out")  ($(fmt "$od"))"
    did=$((did + 1))
  else
    say "   ✖ 합치지 못했습니다. 원본은 그대로 두었습니다."
    echo x >> "$WORK/fail"
  fi
  say ""
done 3< "$WORK/keys.txt"

if [ -f "$WORK/fail" ]; then say "일부를 합치지 못했습니다. 위 ✖ 표시를 확인하세요."; bye 1; fi
if [ "$did" -eq 0 ]; then say "✔ 합칠 것이 없습니다. 모든 단계가 한 파일씩이고 빈 곳이 없습니다."; bye 0; fi
say "■ 끝났습니다. 합친 파일은 이름 끝에 「_이어붙임」, 원본은 「_조각원본」「_예비녹화원본」 폴더에 있습니다."
bye 0
