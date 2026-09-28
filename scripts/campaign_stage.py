"""Allow numbered mainline stages, excluding tutorials and path fragments."""
import argparse,re
def mainline_stage(value):
    if not re.fullmatch(r'(?:0|[1-9][0-9]?)-[1-9][0-9]?',value):
        raise argparse.ArgumentTypeError('Expected numbered mainline stage, e.g. 0-9; TR tutorials excluded')
    return value
