import { describe, expect, it } from "vitest";
import { TOKEN_TAIL_RE, parseProject, parseTags, timeOf } from "./parse";

// 标签/项目解析是「记录零门槛」这条主线的地基：它错了不会报错，
// 只会安静地污染下游的筛选与报告分组，所以边界要钉死。

describe("parseTags", () => {
  it("提取多个标签并去重", () => {
    expect(parseTags("晨会 #会议 联调 #进展 又是 #会议")).toEqual(["会议", "进展"]);
  });

  it("名称到首个标点为止，标点及其后是正文", () => {
    expect(parseTags("#后端联调：进行中")).toEqual(["后端联调"]);
    expect(parseTags("#bug，已修")).toEqual(["bug"]);
    expect(parseTags("#a/b")).toEqual(["a"]);
  });

  it("允许字母数字汉字下划线连字符", () => {
    expect(parseTags("#v1_2-beta 发布")).toEqual(["v1_2-beta"]);
  });

  it("没有标签时返回空数组", () => {
    expect(parseTags("今天写了点代码")).toEqual([]);
    expect(parseTags("#")).toEqual([]); // 光一个 # 不成词
  });
});

describe("parseProject", () => {
  it("只取第一个项目，冒号后是正文", () => {
    expect(parseProject("@DayLog：开始打包")).toBe("DayLog");
    expect(parseProject("@支付系统 联调 @风控")).toBe("支付系统");
  });

  it("没有项目时返回 null", () => {
    expect(parseProject("普通记录")).toBeNull();
  });
});

describe("TOKEN_TAIL_RE", () => {
  it("匹配光标处正在键入的词缀", () => {
    expect("上午开会 #会".match(TOKEN_TAIL_RE)?.[0]).toBe("#会");
    expect("刚敲下 @".match(TOKEN_TAIL_RE)?.[0]).toBe("@"); // 刚打出 @，候选应全列
  });

  it("词缀后面跟了空格或标点就不再算在键入中", () => {
    expect("#会议 ".match(TOKEN_TAIL_RE)).toBeNull();
    expect("#会议：".match(TOKEN_TAIL_RE)).toBeNull();
  });
});

describe("timeOf", () => {
  it("从 ISO 时间戳取 HH:MM", () => {
    expect(timeOf("2026-06-12T14:32:07+08:00")).toBe("14:32");
  });
});
