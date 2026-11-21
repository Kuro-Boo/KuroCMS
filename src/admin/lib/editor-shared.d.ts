// 管理画面へ焼くときに差し込む KuroEditor の純関数の型(scripts/build-admin.js の SHARED_EDITOR_FILES)。
// 実装は KuroEditor の src に 1 つだけ。画面はつないで焼くので import せず、全体の関数として呼ぶ。

/** IME 変換中のキー入力か(KuroEditor/src/ime.js・仕様 editor-editor-spec-ime)。Enter を拾う keydown は必ず通す。 */
declare function isImeComposing(
  e: { isComposing?: boolean; keyCode?: number } | null | undefined,
): boolean;
