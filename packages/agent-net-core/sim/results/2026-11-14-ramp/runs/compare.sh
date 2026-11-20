for mib in 1 20; do echo "=== $mib MiB: $*";
files=""; for v in "$@"; do files="$files $v-${mib}mib.txt"; done
paste -d'#' $files | awk -F'#' '{line=""; for(i=1;i<=NF;i++){split($i,a,"|"); if(i==1) line=sprintf("%-30s",substr(a[1],1,30)); gsub(/ /,"",a[2]);gsub(/ /,"",a[3]);gsub(/ /,"",a[4]);gsub(/ /,"",a[5]); line=line sprintf("|| %s %s %s %s ", a[2],a[3],a[4],substr(a[5],1,4))} print line}' | tail -n +2; done
