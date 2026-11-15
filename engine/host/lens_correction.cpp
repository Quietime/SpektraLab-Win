#include "lens_correction.hpp"
#include "platform.hpp"
#include "core/json.hpp"
#include "pipeline/parallel_lines.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <limits>
#include <mutex>

namespace spkhost {namespace {
using spk::Json;
std::mutex lock;std::filesystem::path database_path;Json database;bool loaded=false;
std::string fold(const std::string& s){std::string r;for(unsigned char c:s)if(c<128&&std::isalnum(c))r+=char(std::tolower(c));return r;}
void load(){if(loaded)return;loaded=true;std::vector<uint8_t> bytes;std::string why;
 if(read_file(database_path,bytes,why))Json::parse(std::string(bytes.begin(),bytes.end()),database,why);}
double camera_crop(const Metadata& m){
 if(m.focal_mm&&m.focal_35mm&&*m.focal_mm>0)return *m.focal_35mm / *m.focal_mm;
 const auto model=fold(m.model),maker=fold(m.make);
 for(const auto& c:database.at("cameras").items())if(fold(c.at("maker").as_string())==maker)
  for(const auto& n:c.at("models").items())if(fold(n.as_string())==model)return c.at("crop").as_double(1);
 return 1;
}
std::string unbrand(std::string name,const std::string& brand){const auto b=fold(brand);if(!b.empty()&&name.starts_with(b))name.erase(0,b.size());return name;}
const Json* match(const Metadata& m){
 load();if(m.lens.empty())return nullptr;
 const auto given=unbrand(fold(m.lens),m.make);const double crop=camera_crop(m);
 const Json* best=nullptr;double distance=1e10;bool ambiguous=false;
 for(const auto& lens:database.at("lenses").items()){
  const auto name=unbrand(unbrand(fold(lens.at("model").as_string()),m.make),lens.at("maker").as_string());
  const auto request=unbrand(given,lens.at("maker").as_string());
  if(name!=request)continue;
  const double calibration=lens.at("crop").as_double(1);
  if(calibration>crop*1.05)continue; // Do not extend an APS-C calibration over a full-frame sensor.
  const double d=std::abs(std::log(calibration/crop));
  if(d<distance-1e-6){best=&lens;distance=d;ambiguous=false;}
  else if(std::abs(d-distance)<1e-6&&best&&best->at("model").as_string()!=lens.at("model").as_string())ambiguous=true;
 }
 return ambiguous?nullptr:best;
}
struct Coeff {int model=0;std::array<double,6> v{};};
double hermite(double a,double b,double c,double d,double t){
 const double b1=std::isnan(a)?c-b:(c-a)*.5,c1=std::isnan(d)?c-b:(d-b)*.5,t2=t*t,t3=t2*t;
 return (2*t3-3*t2+1)*b+(t3-2*t2+t)*b1+(-2*t3+3*t2)*c+(t3-t2)*c1;
}
Coeff interpolate(const Json& lens,const char* key,double focal){
 std::vector<const Json*> samples;Coeff out;
 for(const auto& item:lens.at(key).items()){
  if(!out.model)out.model=item.at("model").as_int();
  if(item.at("model").as_int()==out.model)samples.push_back(&item);
 }
 if(samples.empty())return out;
 std::sort(samples.begin(),samples.end(),[](auto a,auto b){return a->at("focal").as_double()<b->at("focal").as_double();});
 auto next=std::lower_bound(samples.begin(),samples.end(),focal,[](auto p,double f){return p->at("focal").as_double()<f;});
 if(next==samples.begin()||next==samples.end()||(*next)->at("focal").as_double()==focal){
  const auto* p=next==samples.end()?samples.back():*next;
  for(size_t i=0;i<p->at("terms").items().size()&&i<6;i++)out.v[i]=p->at("terms").items()[i].as_double();return out;
 }
 const size_t right=size_t(next-samples.begin()),left=right-1;
 const double t=(focal-samples[left]->at("focal").as_double())/(samples[right]->at("focal").as_double()-samples[left]->at("focal").as_double());
 for(size_t i=0;i<samples[left]->at("terms").items().size()&&i<6;i++){
  auto scaled=[&](size_t n){const auto* p=samples[n];return p->at("terms").items()[i].as_double()*
    ((std::string(key)=="tca"&&i<2)?1:p->at("focal").as_double());};
  out.v[i]=hermite(left?scaled(left-1):NAN,scaled(left),scaled(right),right+1<samples.size()?scaled(right+1):NAN,t)/
    ((std::string(key)=="tca"&&i<2)?1:focal);
 }return out;
}
Coeff vignette(const Json& lens,double focal,double aperture){
 Coeff out;double total=0,closest=1e10;const double range=lens.at("max_focal").as_double()-lens.at("min_focal").as_double();
 if(!(aperture>0))return out;
 for(const auto& item:lens.at("vignetting").items()){
  const double df=(item.at("focal").as_double()-focal)/(range?range:1);
  const double da=4/item.at("aperture").as_double()-4/aperture,dd=.1/item.at("distance").as_double(1000)-.0001;
  const double d=std::sqrt(df*df+da*da+dd*dd);closest=std::min(closest,d);
  const double weight=d<.0001?1:std::pow(d,-3.5);
  if(d<.0001){total=0;out.v={};}
  for(int i=0;i<3;i++)out.v[i]+=item.at("terms").items()[i].as_double()*weight;
  total+=weight;if(d<.0001)break;
 }
 if(closest>1||!total)return {};
 for(double& v:out.v)v/=total;out.model=5;return out;
}
}
void configure_lens_database(const std::filesystem::path& path){std::lock_guard guard(lock);database_path=path;database=Json();loaded=false;}
std::string matched_lens_profile(const Metadata& m){std::lock_guard guard(lock);const auto* p=match(m);return p?p->at("model").as_string():std::string();}

bool correct_lens(FloatImage& image,const Metadata& m,LensCorrectionReport& report,std::string& error){
 if(image.width<2||image.height<2||image.rgb.size()!=size_t(image.width)*image.height*3){error="invalid lens-correction image";return false;}
 Json lens;double crop;
 {std::lock_guard guard(lock);const auto* p=match(m);if(!p){error="no unambiguous measured lens profile matches this photograph";return false;}lens=*p;crop=camera_crop(m);}
 if(!m.focal_mm||*m.focal_mm<=0){error="lens correction requires the photograph's focal length";return false;}
 const double focal=*m.focal_mm;auto d=interpolate(lens,"distortion",focal),t=interpolate(lens,"tca",focal),v=vignette(lens,focal,m.aperture.value_or(0));
 if(!d.model&&!t.model&&!v.model){error="this lens has no applicable calibration";return false;}
 const double W=std::max(1u,image.width-1),H=std::max(1u,image.height-1),size=std::min(W,H),aspect=std::max(W,H)/size;
 const double ar=std::sqrt(std::pow(lens.at("aspect").as_double(1.5),2)+1);
 const double correction=ar/std::sqrt(aspect*aspect+1)*lens.at("crop").as_double(1)/crop,norm=2/size*correction;
 double ox=lens.at("center").items()[0].as_double(),oy=lens.at("center").items()[1].as_double();
 if(m.orientation==6){const double a=ox;ox=-oy;oy=a;}else if(m.orientation==8){const double a=ox;ox=oy;oy=-a;}else if(m.orientation==3){ox=-ox;oy=-oy;}
 const double cx=(W/size+ox)*correction,cy=(H/size+oy)*correction;
 auto map=[&](double x,double y,int channel,double zoom){
  x=(x*norm-cx)/zoom;y=(y*norm-cy)/zoom;double r2=x*x+y*y,r=std::sqrt(r2),k=1;
  if(d.model==1)k=1-d.v[0]+d.v[0]*r2;
  else if(d.model==2)k=1+d.v[0]*r2+d.v[1]*r2*r2;
  else if(d.model==3)k=d.v[0]*r2*r+d.v[1]*r2+d.v[2]*r+1-d.v[0]-d.v[1]-d.v[2];
  x*=k;y*=k;
  if(channel!=1&&t.model){const int c=channel==0?0:1;r2=x*x+y*y;r=std::sqrt(r2);
    k=t.v[c]+(t.model==1?t.v[2+c]*r+t.v[4+c]*r2:0);x*=k;y*=k;}
  return std::array<double,2>{(x+cx)/norm,(y+cy)/norm};
 };
 auto fits=[&](double zoom){for(int i=0;i<=256;i++)for(int edge=0;edge<4;edge++)for(int c=0;c<3;c++){
   const double q=double(i)/256,x=edge<2?q*W:(edge==2?0:W),y=edge<2?(edge==0?0:H):q*H;
   const auto p=map(x,y,c,zoom);if(!std::isfinite(p[0])||!std::isfinite(p[1])||p[0]<-1e-5||p[0]>W+1e-5||p[1]<-1e-5||p[1]>H+1e-5)return false;
  }return true;};
 double zoom=1;if(d.model||t.model){double lo=.125,hi=8;if(!fits(hi)){error="lens calibration has no valid image region";return false;}for(int n=0;n<32;n++){double mid=(lo+hi)/2;if(fits(mid))hi=mid;else lo=mid;}zoom=hi;}
 if(v.model){
  bool valid=true;for(int y=0;y<=16;y++)for(int x=0;x<=16;x++){
    const double xx=(W*x/16*norm-cx)/ar,yy=(H*y/16*norm-cy)/ar,r2=xx*xx+yy*yy;
    const double attenuation=1+v.v[0]*r2+v.v[1]*r2*r2+v.v[2]*r2*r2*r2;if(!(attenuation>0&&std::isfinite(attenuation)))valid=false;
  }if(!valid){error="vignetting calibration is outside its valid sensor region";return false;}
  spk::portable_for_each_line(image.height,[&](uint32_t y){for(uint32_t x=0;x<image.width;x++){
    const double xx=(x*norm-cx)/ar,yy=(y*norm-cy)/ar,r2=xx*xx+yy*yy;
    const double gain=1/(1+v.v[0]*r2+v.v[1]*r2*r2+v.v[2]*r2*r2*r2);
    for(int c=0;c<3;c++)image.rgb[(size_t(y)*image.width+x)*3+c]*=float(gain);
  }});
 }
 if(d.model||t.model){std::vector<float> pixels(image.rgb.size());
  spk::portable_for_each_line(image.height,[&](uint32_t y){for(uint32_t x=0;x<image.width;x++)for(int c=0;c<3;c++){
    const auto p=map(x,y,c,zoom);const double fx=std::clamp(p[0],0.,W),fy=std::clamp(p[1],0.,H);
    const size_t x0=size_t(fx),y0=size_t(fy),x1=std::min(x0+1,size_t(W)),y1=std::min(y0+1,size_t(H));const double a=fx-x0,b=fy-y0;
    auto at=[&](size_t xx,size_t yy){return image.rgb[(yy*image.width+xx)*3+c];};
    pixels[(size_t(y)*image.width+x)*3+c]=float((at(x0,y0)*(1-a)+at(x1,y0)*a)*(1-b)+(at(x0,y1)*(1-a)+at(x1,y1)*a)*b);
  }});image.rgb=std::move(pixels);
 }
 report={lens.at("model").as_string(),zoom,bool(d.model),bool(t.model),bool(v.model)};return true;
}
}
