"""Director-only explicit window restore. Does not press keys or click the game."""
import argparse,json,pathlib,sys
from window import restore

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--cancel-file',type=pathlib.Path,required=True)
 args=parser.parse_args()
 try:print(json.dumps(restore(args.cancel_file)))
 except Exception as error:
  print(json.dumps({'error':str(error),'inputSent':False,'verified':False}))
  print(str(error),file=sys.stderr)
  raise SystemExit(1)

if __name__=='__main__':main()
