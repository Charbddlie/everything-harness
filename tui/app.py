"""Two plain checkbox lists, controlled with arrows, Space and Enter."""

import asyncio
import sqlite3

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Label, OptionList, Static

from .manager import Manager


class CheckList(OptionList):
    # Process navigation and toggles in the same key queue as Enter.
    BINDINGS = [
        Binding("up", "cursor_up", "上移", show=False, priority=True),
        Binding("down", "cursor_down", "下移", show=False, priority=True),
        Binding("space", "select", "勾选", show=False, priority=True),
    ]

    def __init__(self, choices: list[tuple[str, str]], *, checked: bool = False, id: str):
        self.choices = choices
        self.checked = {value for _, value in choices} if checked else set()
        super().__init__(*[self.prompt(index) for index in range(len(choices))], id=id, wrap=False)

    @property
    def selected(self) -> list[str]:
        return [value for _, value in self.choices if value in self.checked]

    def prompt(self, index: int) -> Text:
        label, value = self.choices[index]
        return Text(f"[{'✓' if value in self.checked else ' '}] {label}")

    def action_select(self) -> None:
        index = self.highlighted
        if self.disabled or index is None:
            return
        value = self.choices[index][1]
        self.checked.symmetric_difference_update({value})
        self.replace_option_prompt_at_index(index, self.prompt(index))


class Installer(App[list[str] | None]):
    ENABLE_COMMAND_PALETTE = False
    BINDINGS = [
        Binding("enter", "continue", "下一步", priority=True),
        Binding("escape", "back", "返回", priority=True),
        Binding("ctrl+c", "cancel", "取消", priority=True),
    ]
    CSS = """
    Screen { padding: 1 2; background: #111111; color: #dddddd; }
    Label, Static { height: auto; }
    #title { text-style: bold; margin-bottom: 1; }
    #hint { color: #999999; margin-bottom: 1; }
    CheckList, CheckList:focus {
        height: auto; max-height: 60%; min-height: 1;
        border: none; padding: 0; background: transparent; background-tint: transparent;
    }
    CheckList > .option-list--option-highlighted,
    CheckList:focus > .option-list--option-highlighted {
        background: #262626; color: #ffffff; text-style: bold;
    }
    #skills { display: none; }
    #status { margin-top: 1; }
    #status.error { color: #ee8888; }
    """

    def __init__(self, manager: Manager):
        super().__init__()
        self.manager = manager
        self.step = 1
        self.busy = False
        self.install_error: str | None = None

    def compose(self) -> ComposeResult:
        yield Label("选择 harness  (1/2)", id="title")
        yield Label("↑↓ 移动  ·  空格勾选  ·  Enter 下一步  ·  Esc 取消", id="hint")
        yield CheckList([(agent.label, key) for key, agent in self.manager.agents.items()], id="agents")
        yield CheckList([(name, name) for name in self.manager.discover()], checked=True, id="skills")
        yield Static("", id="status", markup=False)

    def on_mount(self) -> None:
        self.query_one("#agents").focus()

    def show_step(self, step: int) -> None:
        self.step = step
        self.query_one("#agents").display = step == 1
        self.query_one("#skills").display = step == 2
        self.query_one("#title", Label).update("选择 harness  (1/2)" if step == 1 else "选择 skills  (2/2)")
        self.query_one("#hint", Label).update(
            "↑↓ 移动  ·  空格勾选  ·  Enter 下一步  ·  Esc 取消" if step == 1 else
            "↑↓ 移动  ·  空格勾选  ·  Enter 安装  ·  Esc 返回  ·  Ctrl+C 取消"
        )
        status = self.query_one("#status", Static)
        status.remove_class("error")
        status.update("没有可用的 skill，将只安装公共规则。" if step == 2 and not self.query_one("#skills", CheckList).choices else "")
        self.query_one("#agents" if step == 1 else "#skills").focus()

    def action_continue(self) -> None:
        if self.busy:
            return
        if self.step == 1:
            if not self.query_one("#agents", CheckList).selected:
                self.query_one("#status", Static).update("请先用空格选择至少一个 harness。")
                return
            self.show_step(2)
        else:
            self.busy = True
            self.query_one("#skills").disabled = True
            status = self.query_one("#status", Static)
            status.remove_class("error")
            status.update("正在安装并同步状态…")
            self.install_selection()

    @work
    async def install_selection(self) -> None:
        agents = self.query_one("#agents", CheckList).selected
        skills = self.query_one("#skills", CheckList).selected
        try:
            messages = await asyncio.to_thread(self.manager.install, agents, skills)
        except (OSError, ValueError, sqlite3.Error) as error:
            self.install_error = str(error)
            status = self.query_one("#status", Static)
            status.add_class("error")
            status.update(f"安装失败：{error}\nEnter 重试，Esc 返回，Ctrl+C 退出。")
        else:
            self.install_error = None
            self.exit(messages)
        finally:
            self.busy = False
            self.query_one("#skills").disabled = False
            self.query_one("#skills").focus()

    def action_back(self) -> None:
        if not self.busy:
            if self.step == 2:
                self.show_step(1)
            else:
                self.action_cancel()

    def action_cancel(self) -> None:
        if not self.busy:
            self.exit(None)
