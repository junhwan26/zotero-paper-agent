# Zotero Plugin GitHub 배포 가이드

이 프로젝트(`zotero-plugin-template`)를 GitHub Releases 기반으로 배포하는 절차입니다.

## 1) 최초 1회 설정

### 1-1. `package.json` 메타데이터 수정

아래 항목을 실제 값으로 바꿉니다.

- `version` (예: `0.1.0`)
- `config.addonName`
- `config.addonID` (반드시 전역 고유값)
- `config.addonRef`
- `config.addonInstance`
- `config.prefsPrefix`
- `repository.url`
- `bugs.url`
- `homepage`

예시:

```json
{
  "version": "0.1.0",
  "config": {
    "addonName": "Paper Agent",
    "addonID": "paperchat@yourdomain.com",
    "addonRef": "paperchat",
    "addonInstance": "PaperChat",
    "prefsPrefix": "extensions.zotero.paperchat"
  }
}
```

### 1-2. GitHub 원격 저장소 연결

```bash
git remote add origin https://github.com/<owner>/<repo>.git
git branch -M main
git push -u origin main
```

### 1-3. GitHub Actions 권한 확인

이 템플릿은 `.github/workflows/release.yml`에서 태그(`v*`) 푸시 시 릴리즈를 만듭니다.  
Repository Settings > Actions가 활성화되어 있어야 합니다.

## 2) 배포 전 로컬 점검

```bash
npm install
npx tsc --noEmit
npm run build
```

빌드 성공 시 산출물:

- `.scaffold/build/*.xpi`
- `.scaffold/build/update.json` 또는 `update-beta.json`

## 3) GitHub 릴리즈 배포 (권장: 태그 기반)

### 방법 A: `npm run release` 사용 (권장)

```bash
npm run release
```

- 버전 선택 프롬프트(패치/마이너/메이저)가 뜹니다.
- 버전 반영 + 태그 생성 + push까지 진행됩니다.
- 이후 GitHub Actions가 자동으로 릴리즈/에셋(XPI, update manifest)을 생성합니다.

### 방법 B: 수동 버전 태그

```bash
npm version patch
git push origin main --follow-tags
```

- `vX.Y.Z` 태그가 푸시되면 release workflow가 동작합니다.

## 4) 배포 후 확인 체크리스트

1. GitHub Actions의 `Release` workflow 성공 여부
2. GitHub Releases에 `.xpi` 첨부 여부
3. `release` 태그 릴리즈에 `update.json`/`update-beta.json` 존재 여부
4. Zotero에서 `.xpi` 수동 설치 테스트

## 5) Zotero 자동업데이트 연결

`zotero-plugin.config.ts`의 `updateURL`, `xpiDownloadLink`는 기본적으로 GitHub Releases URL 패턴입니다.  
다른 호스트를 쓸 경우 여기 값을 변경해야 자동업데이트가 동작합니다.

## 6) 자주 발생하는 실패 원인

- `addonID` 중복
- `repository.url` 미설정 또는 잘못된 URL
- 태그 형식 오류 (`v1.2.3` 형식 아님)
- GitHub Actions 권한/비활성화 문제
- 의존성 설치 실패(네트워크 문제)

---

필요하면 다음 단계로 `package.json`의 배포 메타데이터를 바로 실제 값으로 같이 맞춰드릴 수 있습니다.
