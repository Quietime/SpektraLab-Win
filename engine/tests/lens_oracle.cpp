// Independent oracle: links the unmodified, pinned Lensfun 0.3.4 library.
// The application itself has no Lensfun/GLib dependency. Run with the original
// XML directory and the application's baked JSON database as arguments.
#include "lens_correction.hpp"
#include <lensfun.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

int main(int argc,char** argv) {
    if(argc!=3)return 2;
    lfDatabase* db=lf_db_new();
    if(!lf_db_load_directory(db,argv[1]))return 2;
    spkhost::configure_lens_database(argv[2]);
    constexpr int w=96,h=64;
    int tested=0,unmatched=0,invalid=0; double worst=0;
    const auto lenses=lf_db_get_lenses(db);
    for(int n=0;lenses[n];n++) {
        const auto* lens=lenses[n];
        if(!lens->CalibDistortion&&!lens->CalibTCA&&!lens->CalibVignetting)continue;
        for(int step=0;step<3;step++) {
            const float focal=lens->MinFocal+(lens->MaxFocal-lens->MinFocal)*step/2;
            const float aperture=lens->MinAperture>0?lens->MinAperture:4;
            spkhost::Metadata metadata;
            // EXIF and the baked index use the canonical (untranslated) name.
            metadata.make=lens->Maker;metadata.lens=lens->Model;
            metadata.focal_mm=focal;metadata.focal_35mm=double(focal)*lens->CropFactor;
            metadata.aperture=aperture;
            if(spkhost::matched_lens_profile(metadata).empty()){unmatched++;continue;}
            spkhost::FloatImage image;image.width=w;image.height=h;image.rgb.resize(w*h*3);
            for(int y=0;y<h;y++)for(int x=0;x<w;x++){
                image.rgb[(y*w+x)*3]=float(x)/(w-1);
                image.rgb[(y*w+x)*3+1]=float(y)/(h-1);
                image.rgb[(y*w+x)*3+2]=.2f+.3f*float(x+y)/(w+h-2);
            }
            auto reference=image.rgb;
            spkhost::LensCorrectionReport report;std::string error;
            if(!spkhost::correct_lens(image,metadata,report,error)){invalid++;continue;}
            auto modifier=lf_modifier_new(lens,lens->CropFactor,w,h);
            const auto flags=lf_modifier_initialize(modifier,lens,LF_PF_F32,focal,aperture,1000,
                float(report.zoom),lens->Type,LF_MODIFY_DISTORTION|LF_MODIFY_TCA|LF_MODIFY_VIGNETTING|LF_MODIFY_SCALE,false);
            // Query each pixel independently: Lensfun's scanline recurrence
            // accumulates float error in near-black corner attenuation. This
            // checks the calibration equations, not that recurrence's drift.
            for(int y=0;y<h;y++)for(int x=0;x<w;x++)
                lf_modifier_apply_color_modification(modifier,reference.data()+(y*w+x)*3,float(x),float(y),1,1,LF_CR_3(RED,GREEN,BLUE),3*sizeof(float));
            std::vector<float> coords(w*h*6);
            bool mapped=false;
            for(int y=0;y<h;y++)for(int x=0;x<w;x++)
                mapped=lf_modifier_apply_subpixel_geometry_distortion(modifier,float(x),float(y),1,1,coords.data()+(y*w+x)*6)||mapped;
            double delta=0;
            for(int y=0;y<h;y++)for(int x=0;x<w;x++)for(int c=0;c<3;c++){
                double xx=x,yy=y;
                if(mapped){xx=coords[(y*w+x)*6+c*2];yy=coords[(y*w+x)*6+c*2+1];}
                xx=std::clamp(xx,0.,double(w-1));yy=std::clamp(yy,0.,double(h-1));
                const int x0=int(xx),y0=int(yy),x1=std::min(x0+1,w-1),y1=std::min(y0+1,h-1);
                const double a=xx-x0,b=yy-y0;
                auto at=[&](int X,int Y){return reference[(Y*w+X)*3+c];};
                const double expected=(at(x0,y0)*(1-a)+at(x1,y0)*a)*(1-b)+(at(x0,y1)*(1-a)+at(x1,y1)*a)*b;
                delta=std::max(delta,std::abs(expected-image.rgb[(y*w+x)*3+c]));
            }
            lf_modifier_destroy(modifier);tested++;worst=std::max(worst,delta);
            if(delta>1e-4){std::fprintf(stderr,"FAIL lens=%s crop=%g focal=%g aperture=%g flags=%d delta=%.9g\n",metadata.lens.c_str(),lens->CropFactor,focal,aperture,flags,delta);lf_db_destroy(db);return 1;}
        }
    }
    lf_db_destroy(db);
    std::printf("Lensfun 0.3.4 oracle: %d comparisons; max difference %.9g; unmatched %d; unavailable %d\n",tested,worst,unmatched,invalid);
    return tested>100?0:1;
}
