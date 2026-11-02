"""One model-selected menu return, through the project's guarded native input."""
import pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]

def return_one_level(stop_file,cancelled,controller_factory=None):
    if cancelled():raise InterruptedError('Menu recovery cancelled before input')
    if controller_factory is None:
        sys.path.insert(0,str(ROOT/'scripts/sts2'))
        from native_input import NativeInput
        controller_factory=NativeInput
    controller=controller_factory('YuanShen.exe',stop_file=stop_file,restore_minimized=False)
    try:
        controller.focus()
        if cancelled():raise InterruptedError('Menu recovery cancelled before input')
        receipt=controller.run([{'action':'key','key':'ESC','hold':.08},{'action':'wait','duration':.6}])
        if cancelled():raise InterruptedError('Menu recovery cancelled')
        return {'source':'project_native_input','operation':'dismiss_menu','verified':False,'input':receipt,
                'note':'One ESC sent; the next local observation must confirm the resulting screen'}
    finally:controller.release_all()
