"""Two checkbox pages; all installation work lives in manager.py."""

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Footer, Header, Label, SelectionList

from .manager import Manager


class Installer(App[tuple[list[str], list[str]] | None]):
    TITLE = "Everything Harness"
    BINDINGS = [("escape", "cancel", "取消"), ("ctrl+c", "cancel", "取消")]
    CSS = """
    Screen { align: center middle; }
    .page { width: 90%; max-width: 90; height: 1fr; padding: 1 2; }
    Label { height: auto; margin-bottom: 1; }
    SelectionList { height: 1fr; min-height: 3; border: round $accent; }
    Horizontal { height: 3; margin-top: 1; }
    Button { margin-right: 2; }
    #skills-page { display: none; }
    #error { color: $error; }
    """

    def __init__(self, manager: Manager):
        super().__init__()
        self.manager = manager

    def compose(self) -> ComposeResult:
        selected = self.manager.installed_agents() or list(self.manager.agents)
        names = self.manager.discover()
        yield Header()
        with Vertical(id="agents-page", classes="page"):
            yield Label("1 / 2  选择要安装到的 agent（空格勾选，Tab 切换）")
            yield SelectionList(*[
                (agent.label, key, key in selected) for key, agent in self.manager.agents.items()
            ], id="agents")
            yield Label("", id="error")
            with Horizontal():
                yield Button("下一步", id="next", variant="primary")
                yield Button("取消", id="cancel1")
        with Vertical(id="skills-page", classes="page"):
            yield Label("2 / 2  选择 skills（默认全选）")
            yield SelectionList(*[(name, name, True) for name in names], id="skills")
            yield Label("未勾选的 skill 将从选中的 agent 移除；其他 agent 保持不变。" if names else "content/ 下暂无 skill，将只安装公共规则。")
            with Horizontal():
                yield Button("上一步", id="back")
                yield Button("安装", id="install", variant="success")
                yield Button("取消", id="cancel2")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#agents").focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button = event.button.id
        if button in {"cancel1", "cancel2"}:
            self.action_cancel()
        elif button == "next":
            if not self.query_one("#agents", SelectionList).selected:
                self.query_one("#error", Label).update("请至少选择一个 agent。")
                return
            self.query_one("#agents-page").display = False
            self.query_one("#skills-page").display = True
            self.query_one("#skills").focus()
        elif button == "back":
            self.query_one("#skills-page").display = False
            self.query_one("#agents-page").display = True
            self.query_one("#agents").focus()
        elif button == "install":
            self.exit((list(self.query_one("#agents", SelectionList).selected),
                       list(self.query_one("#skills", SelectionList).selected)))

    def action_cancel(self) -> None:
        self.exit(None)
