/*!
 * dino-bot.js 를 북마클릿 한 줄로 바꾼다.
 *   node js/build-bookmarklet.js          → js/dino-bot.bookmarklet.txt 갱신
 *   node js/build-bookmarklet.js --check  → 파일이 최신인지 확인만 (테스트용)
 *
 * 주석과 들여쓰기만 걷어내고 줄바꿈은 남긴다 (세미콜론 자동 삽입 사고 방지).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, 'dino-bot.js');
const OUTPUT = path.join(__dirname, 'dino-bot.bookmarklet.txt');

function minify(source) {
  return source
    .replace(/^\/\*![\s\S]*?\*\/\s*/, '')            // 파일 머리말 주석
    .split('\n')
    .map((line) => line.replace(/\/\*.*?\*\//g, '').trim())
    .filter((line) => line && !line.startsWith('//')
      && !line.startsWith('/*') && !line.startsWith('*'))
    .map((line) => line.replace(/\s+\/\/\s.*$/, ''))  // 줄 끝 주석
    .join('\n');
}

function build() {
  const code = minify(fs.readFileSync(SOURCE, 'utf8'));
  return 'javascript:' + encodeURIComponent(code) + '\n';
}

if (require.main === module) {
  const bookmarklet = build();
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current !== bookmarklet) {
      console.error('북마클릿 파일이 dino-bot.js 와 다릅니다. '
        + 'node js/build-bookmarklet.js 로 다시 만드세요.');
      process.exit(1);
    }
    console.log('북마클릿 파일이 최신입니다.');
  } else {
    fs.writeFileSync(OUTPUT, bookmarklet);
    console.log(`북마클릿을 만들었습니다: ${OUTPUT} (${bookmarklet.length}바이트)`);
  }
}

module.exports = { build, minify, SOURCE, OUTPUT };
